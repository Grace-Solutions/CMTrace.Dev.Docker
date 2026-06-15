// Command cmtrace is a single-binary static web server that embeds the
// CMTrace.dev PWA assets and serves them locally. It mirrors the SPA
// fallback behaviour of the production nginx config: paths with no file
// extension that do not resolve to a file on disk are rewritten to
// /index.html so deep links work.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
)

//go:embed all:src
var siteFS embed.FS

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	addr := flag.String("listen", "127.0.0.1:19847", "address:port to bind on")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("cmtrace %s\n", version)
		return
	}

	sub, err := fs.Sub(siteFS, "src")
	if err != nil {
		log.Fatalf("embed: %v", err)
	}

	// Go's mime package does not ship these by default on every platform.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")

	handler := withSPAFallback(sub, http.FileServer(http.FS(sub)))

	log.Printf("cmtrace %s listening on http://%s/", version, *addr)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
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
