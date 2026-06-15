window.CMT = window.CMT || {};

/*
 * CMT.errorKB — curated knowledge base for common ConfigMgr / Intune error
 * codes with cause, fix, and Microsoft Learn reference links.
 *
 * Shape of each entry:
 *   { cause: "...", fix: "...", learn: "https://learn.microsoft.com/..." }
 *
 * Keys are stored in two canonical forms for every code:
 *   - Uppercase 0x-hex string:  "0x80004005"
 *   - Unsigned decimal string:  "2147500037"
 *
 * Public API (exposed on CMT.errorKB):
 *   entries           — the raw map (object keyed by both forms)
 *   lookup(code)      — {cause,fix,learn}|null
 *   learnUrl(code)    — string (entry.learn or a MS Learn search URL)
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  var POW32 = 4294967296; // 2^32

  /**
   * Reduce an integer into its canonical uint32 representation, then return
   * both the uppercase 0x-hex and unsigned-decimal string keys.
   * @param {number} n  — any finite integer (may be negative / > 2^32)
   * @returns {{hex:string, dec:string}}
   */
  function keys(n) {
    var u = ((Math.trunc(n) % POW32) + POW32) % POW32;
    var hex = '0x' + u.toString(16).toUpperCase().padStart(8, '0');
    var dec = String(u);
    return { hex: hex, dec: dec };
  }

  /** @type {Object.<string,{cause:string,fix:string,learn:string}>} */
  var entries = Object.create(null);

  /**
   * Register one knowledge-base entry under all canonical key forms.
   * @param {number}  code   — numeric value (hex or decimal literal)
   * @param {string}  cause  — concise root-cause description
   * @param {string}  fix    — recommended remediation steps
   * @param {string}  learn  — Microsoft Learn URL (or '' to auto-generate search URL)
   */
  function add(code, cause, fix, learn) {
    var k = keys(code);
    var entry = { cause: cause, fix: fix, learn: learn };
    entries[k.hex] = entry;
    entries[k.dec] = entry;
  }

  // ---------------------------------------------------------------------------
  // Knowledge base entries
  // ---------------------------------------------------------------------------

  // ---- General HRESULT / COM ------------------------------------------------

  add(0x80004005,
    'E_FAIL — Unspecified failure. Commonly a generic catch-all error in ConfigMgr when no more specific code is available.',
    'Check the component log immediately preceding this error for a more specific code. Verify WMI health (winmgmt /verifyrepository) and ensure the SCCM client services are running.',
    'https://learn.microsoft.com/en-us/windows/win32/com/com-error-codes-1');

  add(0x80070005,
    'E_ACCESSDENIED / ERROR_ACCESS_DENIED — The process lacked the required permissions to access a resource (registry key, file, WMI namespace, COM object).',
    'Run the action as a user or SYSTEM account with sufficient rights. Check DCOM/WMI security permissions, UAC settings, and that the SCCM client account has local admin if required.',
    'https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-');

  add(0x80070002,
    'ERROR_FILE_NOT_FOUND — A required file, policy, or registry path does not exist on the target device.',
    'Verify the content is fully distributed to the distribution point, the download path is accessible, and the detection method or script path is correct.',
    'https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-');

  add(0x8007007E,
    'ERROR_MOD_NOT_FOUND — The specified module or DLL could not be found.',
    'Ensure all required redistributables and dependencies are installed. Check that the working directory is correct and PATH contains the required locations.',
    'https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-');

  add(0x800700B7,
    'ERROR_ALREADY_EXISTS — Cannot create a file when that file already exists.',
    'Remove or rename the existing file/folder before re-running the operation, or adjust the installation to handle existing installations (e.g. use /repair or a reinstall flag).',
    'https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-');

  // ---- MSI / Windows Installer exit codes ----------------------------------

  add(1603,
    'ERROR_INSTALL_FAILURE — A fatal error occurred during MSI installation. This is the most common catch-all MSI failure code.',
    'Enable verbose MSI logging (/log or msiexec /l*v). Review the MSI log for the actual failing action. Common causes: insufficient disk space, running processes locking files, missing prerequisites, corrupt package, or incorrect command-line parameters.',
    'https://learn.microsoft.com/en-us/troubleshoot/windows-client/deployment/msi-installer-error-1603');

  add(1618,
    'ERROR_INSTALL_ALREADY_RUNNING — Another installation is already in progress. Windows Installer cannot install two packages simultaneously.',
    'Wait for the in-progress installation to complete (check Task Manager for msiexec.exe). If stuck, kill the orphaned msiexec process and clear the HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\InProgress key.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  add(1619,
    'ERROR_INSTALL_PACKAGE_OPEN_FAILED — The installation package could not be opened. The file may be missing, inaccessible, or corrupt.',
    'Verify the package path and that the account running the install has read access. Re-download or re-distribute the package if it is corrupt. Check for UNC path connectivity.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  add(1620,
    'ERROR_INSTALL_PACKAGE_INVALID — The installation package is not valid or is corrupt.',
    'Re-download the package from the vendor. Verify file hashes. Ensure the package was not altered after being signed.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  add(1602,
    'ERROR_INSTALL_USEREXIT — The user cancelled the installation.',
    'Ensure the deployment runs silently (/qn) and that no UI prompts require user interaction. Check that suppress reboot and user interaction flags are set correctly in the deployment.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  add(1612,
    'ERROR_INSTALL_SOURCE_ABSENT — The installation source for this product is not available. Verify that the source exists and that you can access it.',
    'Re-distribute the content to all distribution points. Check that the client can reach the DP, that BITS is running, and that the source path has not moved.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  add(3010,
    'ERROR_SUCCESS_REBOOT_REQUIRED — The installation completed successfully but requires a restart to take effect.',
    'This is a soft success. Schedule or force a restart. In ConfigMgr, configure the deployment to allow or require a reboot. In Intune, use the Restart behavior setting.',
    'https://learn.microsoft.com/en-us/windows/win32/msi/windows-installer-error-messages');

  // ---- SCCM / ConfigMgr client SDM codes -----------------------------------

  add(0x87D00324,
    'SCCM: The application was not detected after installation completed. The detection method returned "not detected" even though the install appeared to succeed.',
    'Review and correct the detection method (registry, file version, WMI, or script). Ensure it matches the exact installed version/path. Run the detection method manually on the device. Check AppEnforce.log and AppDiscovery.log.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/troubleshoot-application-deployment');

  add(0x87D00269,
    'SCCM: Application requirement rules were not met on the target device. A global condition or requirement rule evaluated to false.',
    'Review the requirement rules in the deployment type. Run CMPivot or a hardware inventory to verify the device actually meets the conditions. Check AppDiscovery.log and CIAgent.log.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/troubleshoot-application-deployment');

  add(0x87D00667,
    'SCCM: No distribution point was available or reachable for the content associated with this deployment.',
    'Verify the content is distributed to a DP in the client\'s boundary group. Check ContentTransferManager.log, LocationServices.log, and DataTransferService.log. Ensure BITS is running and firewall rules allow HTTP/HTTPS to the DP.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/servers/deploy/configure/boundary-groups');

  add(0x87D01006,
    'SCCM: The content download or transfer failed. The content hash validation may have failed or the transfer was interrupted.',
    'Re-distribute the content package. Check DataTransferService.log and ContentTransferManager.log for the underlying BITS or HTTP error. Validate content on the DP using the ConfigMgr console.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/plan-design/hierarchy/fundamental-concepts-for-content-management');

  add(0x87D00440,
    'SCCM: The CI (Configuration Item) version required for this deployment is not yet available on the client. The policy download may be lagging.',
    'Force a machine policy retrieval and evaluation cycle from the Configuration Manager control panel applet. Check PolicyAgent.log and CIAgent.log.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/manage/manage-clients');

  add(0x87D00215,
    'SCCM: The deployment deadline has passed and the application could not be installed.',
    'Check that the client clock is synchronized (w32tm /query /status). Review whether the machine was offline during the deadline window. Extend the deadline or redeploy.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/deploy-applications');

  add(0x87D00607,
    'SCCM: Application enforcement failed during the install or uninstall execution phase.',
    'Check AppEnforce.log for the MSI or script exit code. Enable verbose logging on the installer. Review whether a previous install left the system in a broken state.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/troubleshoot-application-deployment');

  add(0x87D013B6,
    'SCCM: Software update compliance scan failed or the update could not be assessed.',
    'Run Windows Update scan (wuauclt /detectnow or UsoClient StartScan). Check WUAHandler.log and UpdatesDeployment.log. Ensure the WSUS/SUP is reachable.',
    'https://learn.microsoft.com/en-us/mem/configmgr/sum/deploy-use/monitor-software-updates');

  add(0x87D00226,
    'SCCM: The enforcement action is not applicable because the update/application is not required on this device.',
    'This is typically informational — the device is already compliant or the CI does not apply. Verify targeting and collection membership.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/deploy-applications');

  // ---- Intune / IME codes ---------------------------------------------------

  add(0x87D1041C,
    'Intune: The application installation failed. This is a generic Intune Win32 app failure code reported by the Intune Management Extension.',
    'Check the IntuneManagementExtension.log at C:\\ProgramData\\Microsoft\\IntuneManagementExtension\\Logs. Look for the underlying exit code returned by the installer. Verify the install command, detection rule, and that ESP is not blocking.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  add(0x87D10BC3,
    'Intune: Win32 app detection failed — the IME could not evaluate the detection rule after installation.',
    'Review the detection rule in the Intune app configuration. Test the detection script or registry/file rule manually on the device. Check IntuneManagementExtension.log.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  add(0x87D10BC2,
    'Intune: Win32 app installation timed out. The installation process exceeded the allowed time limit.',
    'Increase the installation time limit in the Intune app configuration (up to 60 minutes). Optimize the installer for silent operation. Check if antivirus scanning is slowing the install.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  add(0x87D10BC6,
    'Intune: A dependency app required by this Win32 application is not installed or failed to install.',
    'Ensure all dependency apps are assigned and installed successfully before this app. Check the dependency chain in the Intune app configuration and review IntuneManagementExtension.log.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  add(0x87D10BC5,
    'Intune: The Win32 app supersedence relationship caused an uninstall that failed or blocked the new install.',
    'Check the uninstall command of the superseded app. Verify the supersedence relationship is configured correctly. Review IntuneManagementExtension.log for the uninstall exit code.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  add(0x87D10BC4,
    'Intune: The Win32 app installation was cancelled or aborted, often because a required reboot is pending.',
    'Allow or force a device restart to clear any pending reboot state. Check if another installation is in progress. Review IntuneManagementExtension.log.',
    'https://learn.microsoft.com/en-us/mem/intune/apps/troubleshoot-win32-app-install');

  // ---- Windows Update / WU / WSUS codes ------------------------------------

  add(0x80240022,
    'WU_E_ALL_UPDATES_FAILED — All operations failed for all applicable updates in a single scan/download/install cycle.',
    'Check WindowsUpdate.log (or Get-WindowsUpdateLog on Win10+) for the underlying per-update failure. Ensure WSUS connectivity, run Dism /Online /Cleanup-Image /RestoreHealth, and reset the Windows Update components if necessary.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x8024001E,
    'WU_E_SERVICE_STOP — Operation did not complete because the service or system was being shut down.',
    'Retry the update operation after the system has fully started. Ensure the wuauserv service is set to automatic and is running.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x8024000B,
    'WU_E_CALL_CANCELLED — Operation was cancelled.',
    'Retry the update. If it recurs, check for Group Policy settings that may be cancelling operations, or for a conflicting update management tool.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80240034,
    'WU_E_DOWNLOAD_FAILED — Update failed to download.',
    'Check network connectivity to the update server. Run netsh winhttp show proxy. Check BITS service status. Review WindowsUpdate.log for the HTTP error code.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80244022,
    'WU_E_PT_HTTP_STATUS_SERVICE_UNAVAIL — Same as HTTP 503 — the WSUS or Windows Update server is temporarily unavailable.',
    'Verify the WSUS/WUA server is online and the IIS application pool is running. Check server event logs. Retry after the service recovers.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80244001,
    'WU_E_PT_SOAPCLIENT_INITIALIZE — SOAP client initialization failed. Cannot reach the update server endpoint.',
    'Check DNS resolution for the WSUS or WU server FQDN. Verify proxy and firewall rules. Confirm the WSUS website is bound and running in IIS.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x8024402C,
    'WU_E_PT_WINHTTP_NAME_NOT_RESOLVED — The proxy server or target server name cannot be resolved by DNS.',
    'Verify DNS is working (nslookup <wsus-server>). Check the configured WSUS URL in Group Policy or registry (HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate). Ensure the WSUS server is reachable from the client.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80240016,
    'WU_E_INSTALL_NOT_ALLOWED — Operation tried to install while another installation was in progress or while a required reboot was pending.',
    'Wait for the in-progress installation to complete and restart the device if a reboot is pending. Then retry the update.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80070BC9,
    'ERROR_FAIL_REBOOT_REQUIRED — The requested operation is unsuccessful. Changes will not be effective until the system is rebooted.',
    'Restart the device to complete a previously pending update or configuration change, then retry.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  add(0x80070BC2,
    'ERROR_FAIL_REBOOT_IN_PROGRESS — A reboot is already in progress.',
    'Allow the system to complete its current reboot cycle. Do not interrupt pending reboots.',
    'https://learn.microsoft.com/en-us/windows/deployment/update/windows-update-error-reference');

  // ---- Content / DP / BITS transfer errors ----------------------------------

  add(0x80190194,
    'HTTP 404 — The requested content was not found on the distribution point or web server.',
    'Verify the content is distributed to the DP (validate content in the ConfigMgr console). Check the DP IIS logs. Confirm the package ID and DP URL in ContentTransferManager.log.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/plan-design/hierarchy/fundamental-concepts-for-content-management');

  add(0x80190191,
    'HTTP 401 Unauthorized — The client could not authenticate to the distribution point.',
    'Ensure the DP is configured to allow anonymous access if required, or that the client machine account has rights. Check IIS authentication settings on the DP.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/servers/deploy/configure/install-and-configure-distribution-points');

  add(0x8024500C,
    'BITS / WU transfer error — BITS job failed. Often follows a network interruption or DP unavailability.',
    'Check BITS service status (sc query bits). Review DataTransferService.log and ContentTransferManager.log. Verify DP connectivity on port 80/443.',
    'https://learn.microsoft.com/en-us/windows/win32/bits/bits-return-values');

  // ---- CCMSetup / client installation codes --------------------------------

  add(0x80091007,
    'CRYPT_E_BAD_MSG / Certificate error — The ConfigMgr client certificate is missing, untrusted, or expired.',
    'Check the PKI certificate assigned to the client. Verify the management point and distribution point certificates are trusted. Review CCMSetup.log and SMSTS.log for certificate errors.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/deploy/plan/security-and-privacy-for-clients');

  add(0x80040154,
    'REGDB_E_CLASSNOTREG — A required COM class is not registered on the client.',
    'Re-register the relevant COM server (regsvr32). For SCCM clients, running CCMSetup /repair often resolves this. Check for incomplete .NET or WMI registration.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/deploy/deploy-clients-to-windows-computers');

  add(0x80041001,
    'WBEM_E_FAILED — WMI general failure. WMI is corrupt or a required WMI class/namespace is missing.',
    'Rebuild the WMI repository: net stop winmgmt, then rename %windir%\\System32\\wbem\\Repository and restart. Run winmgmt /verifyrepository and check WMI-Activity event logs.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/manage/manage-clients');

  add(0x80041002,
    'WBEM_E_NOT_FOUND — The requested WMI object, class, or instance does not exist.',
    'Verify the WMI namespace and class name. Re-register SCCM WMI providers (mofcomp.exe on the relevant .mof files in %windir%\\System32\\wbem). Run CCMSetup /repair.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/manage/manage-clients');

  // ---- Policy / Compliance CI codes ----------------------------------------

  add(0x87D00272,
    'SCCM: Script execution failed or returned a non-zero exit code during compliance evaluation.',
    'Test the detection or compliance script manually under SYSTEM context (use PSExec -s). Check for PowerShell execution policy restrictions (Get-ExecutionPolicy) and ensure required modules are available.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/create-deploy-scripts');

  add(0x87D00327,
    'SCCM: The application deployment type could not be detected — detection method script returned an error.',
    'Review the detection script output. Ensure it writes to stdout and exits 0 on success. Check AppDiscovery.log for the raw script output.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/troubleshoot-application-deployment');

  // ---- OSD / Task Sequence codes -------------------------------------------

  add(0x80070070,
    'ERROR_DISK_FULL — There is not enough space on the disk to complete the operation.',
    'Free up disk space on the target drive. For OSD, ensure the target partition is large enough. Check SMSTS.log for which step ran out of space.',
    'https://learn.microsoft.com/en-us/mem/configmgr/osd/understand/task-sequence-steps');

  add(0x80004002,
    'E_NOINTERFACE — No such interface supported. A required COM interface was not found, often indicating a missing or misregistered component.',
    'Repair or reinstall the component that exposes the required COM interface. For SCCM, run CCMSetup /repair. Check the Application event log for registration errors.',
    'https://learn.microsoft.com/en-us/windows/win32/com/com-error-codes-1');

  // ---- Additional common ConfigMgr/Intune codes ----------------------------

  add(0x87D00321,
    'SCCM: The CI handler failed to prepare the content for enforcement.',
    'Verify content is fully downloaded to the client cache. Check CacheManager.log and ContentTransferManager.log for transfer failures. Delete and re-download the content if the cache entry is corrupt.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/plan-design/hierarchy/fundamental-concepts-for-content-management');

  add(0x87D00325,
    'SCCM: Installation of the deployment type failed. Generic enforcement failure after execution began.',
    'Check AppEnforce.log for the installer exit code. Enable verbose MSI or script logging. Confirm the user/SYSTEM account has rights to the install location.',
    'https://learn.microsoft.com/en-us/mem/configmgr/apps/deploy-use/troubleshoot-application-deployment');

  add(0x87D0025E,
    'SCCM: No content locations are available. The client cannot find a suitable distribution point for the required content.',
    'Verify boundary group configuration — ensure the client\'s IP range falls within a boundary associated with a DP boundary group. Check LocationServices.log.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/servers/deploy/configure/boundary-groups');

  add(0x87D00717,
    'SCCM: The software update content was not downloaded because the client\'s cache is full.',
    'Increase the client cache size (Configuration Manager control panel > Cache tab). Remove old or unused cached items via the cache management properties.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/manage/manage-clients');

  add(0x87D01106,
    'SCCM: Software update scan failed — the scan tool (WUA) returned an error during the software update scan cycle.',
    'Check WUAHandler.log for the underlying WUA error code. Ensure the Windows Update service is running and that WSUS is accessible. Run wsyncmgr on the SUP if the issue is catalog related.',
    'https://learn.microsoft.com/en-us/mem/configmgr/sum/deploy-use/monitor-software-updates');

  add(0x80072EE2,
    'ERROR_INTERNET_TIMEOUT — The operation timed out waiting for a response from the server.',
    'Check network connectivity and latency to the target server. Increase BITS/WinHTTP timeout values if on a slow WAN link. Verify no proxy or firewall is silently dropping connections.',
    'https://learn.microsoft.com/en-us/windows/win32/wininet/wininet-error-codes');

  add(0x80072EFD,
    'ERROR_INTERNET_CANNOT_CONNECT — A connection to the server could not be established.',
    'Verify the server FQDN resolves correctly. Check TCP port connectivity (Test-NetConnection). Review proxy settings (netsh winhttp show proxy). Ensure the DP/MP/WU server is online.',
    'https://learn.microsoft.com/en-us/windows/win32/wininet/wininet-error-codes');

  add(0x80072EE7,
    'ERROR_INTERNET_NAME_NOT_RESOLVED — The server name could not be resolved.',
    'Verify DNS is working for the target server FQDN. Check the client\'s DNS server settings and network adapter configuration.',
    'https://learn.microsoft.com/en-us/windows/win32/wininet/wininet-error-codes');

  add(0x80072F8F,
    'ERROR_INTERNET_DECODING_FAILED / TLS/SSL certificate error — The security certificate presented by the server is not trusted or is expired.',
    'Verify the server certificate is not expired and is issued by a trusted CA. Ensure the root CA cert is in the client\'s Trusted Root store. Check the system clock for large time skew.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/deploy/plan/security-and-privacy-for-clients');

  add(0x80072F0D,
    'ERROR_INTERNET_INVALID_CA — The certificate authority that generated the server\'s certificate is not trusted.',
    'Import the root and intermediate CA certificates into the client\'s Trusted Root and Intermediate Certification Authority stores. Ensure PKI is properly deployed.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/deploy/plan/security-and-privacy-for-clients');

  add(0x8007274D,
    'WSAECONNREFUSED — The connection was actively refused by the target host. The port may not be listening.',
    'Verify the target service (DP/MP/WSUS IIS) is running and listening on the expected port. Check Windows Firewall rules on both the client and server.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/plan-design/hierarchy/communications-between-endpoints');

  add(0x80004001,
    'E_NOTIMPL — Not implemented. The called method or interface is not implemented in this version.',
    'Ensure the ConfigMgr client, site server, or component is at the required version and service pack level. Check for hotfix requirements in the Microsoft documentation.',
    'https://learn.microsoft.com/en-us/windows/win32/com/com-error-codes-1');

  add(0x87D00200,
    'SCCM: The operation failed because the client is not currently managed or the management authority check failed.',
    'Verify the client is enrolled and the management point is reachable. Check ClientIDManagerStartup.log and CcmExec event logs.',
    'https://learn.microsoft.com/en-us/mem/configmgr/core/clients/manage/manage-clients');

  // Additional Intune MDM enrollment codes
  add(0x80180001,
    'Intune MDM enrollment error — The device could not be enrolled. An internal service error occurred.',
    'Check the AAD join status (dsregcmd /status). Verify Intune subscription and MDM authority settings. Review the DeviceEnrollment event log.',
    'https://learn.microsoft.com/en-us/mem/intune/enrollment/troubleshoot-windows-enrollment-errors');

  add(0x80180002,
    'Intune MDM: The enrollment token or credential provided was not valid.',
    'Ensure the user has an Intune license assigned and the enrollment restriction policy allows the device type. Re-attempt enrollment with valid credentials.',
    'https://learn.microsoft.com/en-us/mem/intune/enrollment/troubleshoot-windows-enrollment-errors');

  add(0x80180014,
    'Intune: The device is already enrolled with a different MDM authority.',
    'Unenroll from the current MDM (Settings > Accounts > Access work or school) before re-enrolling. Check for any prior MDM enrollment artifacts.',
    'https://learn.microsoft.com/en-us/mem/intune/enrollment/troubleshoot-windows-enrollment-errors');

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Look up a code in the knowledge base.
   * @param {string|number} code  — any code form accepted by CMT.errorlookup.normalizeCode
   * @returns {{cause:string,fix:string,learn:string}|null}
   */
  function lookup(code) {
    if (code === null || code === undefined) return null;
    // Use CMT.errorlookup.normalizeCode when available for consistent normalization.
    if (CMT.errorlookup && typeof CMT.errorlookup.normalizeCode === 'function') {
      var norm = CMT.errorlookup.normalizeCode(code);
      if (!norm) return null;
      // Try hex key first (most explicit), then decimal.
      var byHex = entries[norm.hex];
      if (byHex) return byHex;
      var byDec = entries[norm.dec];
      if (byDec) return byDec;
      return null;
    }
    // Fallback when errorlookup is not yet loaded: try several key forms.
    var raw = String(code).trim();
    // Direct hit (e.g. already "0x80004005" or a decimal string).
    if (entries[raw]) return entries[raw];
    // Uppercase hex digits only (0x stays lowercase to match stored keys).
    if (/^0[xX]/i.test(raw)) {
      var hexKey = '0x' + raw.slice(2).toUpperCase().padStart(8, '0');
      if (entries[hexKey]) return entries[hexKey];
    }
    // Plain decimal string.
    var decKey = String(parseInt(raw, 10) >>> 0);
    if (entries[decKey]) return entries[decKey];
    return null;
  }

  /**
   * Return a Microsoft Learn URL for the given code.
   * Uses the entry's learn URL if present; otherwise builds a search URL.
   * @param {string|number} code
   * @returns {string}
   */
  function learnUrl(code) {
    var entry = lookup(code);
    if (entry && entry.learn) return entry.learn;
    // Generate a Microsoft Learn search URL for the raw code string.
    var term = String(code).trim();
    return 'https://learn.microsoft.com/en-us/search/?terms=' + encodeURIComponent(term);
  }

  CMT.errorKB = {
    entries: entries,
    lookup: lookup,
    learnUrl: learnUrl
  };

})();
