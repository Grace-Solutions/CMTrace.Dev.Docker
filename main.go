// Command cmtrace is a single-binary static web server that embeds the
// CMTrace.dev PWA assets and serves them locally. It mirrors the SPA
// fallback behaviour of the production nginx config and exposes
// install/uninstall/start/stop/restart/status subcommands so it can
// run as a Windows service, systemd unit, launchd agent or OpenRC
// service via github.com/kardianos/service.
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"runtime/debug"
	"strings"
	"time"

	"github.com/kardianos/service"
)

//go:embed all:src
var siteFS embed.FS

// version and commit are overridden at build time via
// -ldflags "-X main.version=... -X main.commit=...". When unset (e.g.
// local `go build`), commit is recovered from the VCS info embedded by
// the Go toolchain since 1.18.
var (
	version = "dev"
	commit  = ""
)

func init() {
	if commit != "" {
		return
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return
	}
	for _, s := range bi.Settings {
		if s.Key == "vcs.revision" {
			commit = s.Value
			return
		}
	}
}

func shortCommit() string {
	switch {
	case len(commit) >= 7:
		return commit[:7]
	case commit != "":
		return commit
	default:
		return "unknown"
	}
}

// program implements service.Interface and owns the lifecycle of the
// embedded http.Server.
type program struct {
	addr   string
	server *http.Server
}

func (p *program) Start(_ service.Service) error {
	sub, err := fs.Sub(siteFS, "src")
	if err != nil {
		return fmt.Errorf("embed: %w", err)
	}
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")

	p.server = &http.Server{
		Addr:              p.addr,
		Handler:           withSPAFallback(sub, http.FileServer(http.FS(sub))),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("cmtrace %s (%s) listening on http://%s/", version, shortCommit(), p.addr)
		if err := p.server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server error: %v", err)
		}
	}()
	return nil
}

func (p *program) Stop(_ service.Service) error {
	if p.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return p.server.Shutdown(ctx)
}

const usage = `usage: cmtrace [subcommand] [--listen host:port]

Subcommands:
  (none)      run in the foreground (or as the service, when launched
              by the OS service manager)
  install     install + start as a system service (uses --listen value
              as the bound address for the installed service)
  uninstall   stop and remove the system service
  start       start the installed service
  stop        stop the installed service
  restart     restart the installed service
  status      print service status (running | stopped | unknown)

Flags:
  --listen    address:port to bind on (default 127.0.0.1:19847)
  --version   print version and commit hash, then exit
`

func main() {
	args := os.Args[1:]
	sub := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}

	fs := flag.NewFlagSet("cmtrace", flag.ExitOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	addr := fs.String("listen", "127.0.0.1:19847", "address:port to bind on")
	showVersion := fs.Bool("version", false, "print version and exit")
	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}

	if *showVersion {
		fmt.Printf("cmtrace %s (%s)\n", version, shortCommit())
		return
	}

	cfg := &service.Config{
		Name:        "cmtrace",
		DisplayName: "CMTrace.dev Local Server",
		Description: "Self-hosted CMTrace.dev log viewer (offline-capable PWA).",
		Arguments:   []string{"--listen", *addr},
	}
	prg := &program{addr: *addr}
	svc, err := service.New(prg, cfg)
	if err != nil {
		log.Fatalf("service init: %v", err)
	}

	switch sub {
	case "":
		if err := svc.Run(); err != nil {
			log.Fatalf("run: %v", err)
		}
	case "install":
		if err := service.Control(svc, "install"); err != nil {
			log.Fatalf("install: %v", err)
		}
		if err := service.Control(svc, "start"); err != nil {
			log.Fatalf("start: %v", err)
		}
		fmt.Printf("cmtrace service installed and started (listen %s)\n", *addr)
	case "uninstall":
		_ = service.Control(svc, "stop")
		if err := service.Control(svc, "uninstall"); err != nil {
			log.Fatalf("uninstall: %v", err)
		}
		fmt.Println("cmtrace service stopped and removed")
	case "start", "stop", "restart":
		if err := service.Control(svc, sub); err != nil {
			log.Fatalf("%s: %v", sub, err)
		}
		fmt.Printf("cmtrace service %s\n", sub+"ed")
	case "status":
		st, err := svc.Status()
		if err != nil {
			log.Fatalf("status: %v", err)
		}
		fmt.Println(statusName(st))
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %q\n\n%s", sub, usage)
		os.Exit(2)
	}
}

func statusName(s service.Status) string {
	switch s {
	case service.StatusRunning:
		return "running"
	case service.StatusStopped:
		return "stopped"
	default:
		return "unknown"
	}
}

// withSPAFallback rewrites requests for non-existent extensionless paths
// to "/", which causes the underlying http.FileServer to serve index.html
// from the embedded FS. Mirrors the nginx `try_files $uri $uri/ /index.html`
// + `error_page 404 /index.html` behaviour in docker/nginx/default.conf.
// Rewriting to "/" (rather than "/index.html") avoids FileServer's built-in
// 301 redirect of any path ending in "/index.html" to "./".
func withSPAFallback(root fs.FS, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" && path.Ext(p) == "" {
			if _, err := fs.Stat(root, p); err != nil {
				r.URL.Path = "/"
			}
		}
		h.ServeHTTP(w, r)
	})
}
