window.CMT = window.CMT || {};

(function () {
  'use strict';

  // Error code database for Windows, Win32, MSI/Installer, HRESULT, SCCM/ConfigMgr, WU codes.
  // Keys are strings. Supported key forms:
  //   - Unsigned decimal:   "0", "5", "1603", "2147942405"
  //   - Uppercase 0x-hex:   "0x00000000", "0x80070005"
  //   - Signed decimal (HRESULT negatives): "-2147467259"
  // Each entry: { name: "SYMBOLIC_NAME", desc: "Human readable description", source: "Win32"|"MSI"|"HRESULT"|"WU"|"SCCM" }

  var codes = {};

  function add(unsigned, hex8, signed, name, desc, source) {
    var entry = { name: name, desc: desc, source: source || 'Win32' };
    var uStr = String(unsigned >>> 0);
    var hStr = '0x' + ('00000000' + (unsigned >>> 0).toString(16).toUpperCase()).slice(-8);
    var sStr = String(signed);
    codes[uStr] = entry;
    if (hex8) codes[hStr] = entry;
    if (signed < 0) codes[sStr] = entry;
  }

  // -----------------------------------------------------------------------
  // Win32 System Errors (Winerror.h)
  // -----------------------------------------------------------------------
  add(0,          true,  0,           'ERROR_SUCCESS',                     'The operation completed successfully.', 'Win32');
  add(1,          true,  1,           'ERROR_INVALID_FUNCTION',            'Incorrect function.', 'Win32');
  add(2,          true,  2,           'ERROR_FILE_NOT_FOUND',              'The system cannot find the file specified.', 'Win32');
  add(3,          true,  3,           'ERROR_PATH_NOT_FOUND',              'The system cannot find the path specified.', 'Win32');
  add(4,          true,  4,           'ERROR_TOO_MANY_OPEN_FILES',         'The system cannot open the file.', 'Win32');
  add(5,          true,  5,           'ERROR_ACCESS_DENIED',               'Access is denied.', 'Win32');
  add(6,          true,  6,           'ERROR_INVALID_HANDLE',              'The handle is invalid.', 'Win32');
  add(7,          true,  7,           'ERROR_ARENA_TRASHED',               'The storage control blocks were destroyed.', 'Win32');
  add(8,          true,  8,           'ERROR_NOT_ENOUGH_MEMORY',           'Not enough storage is available to process this command.', 'Win32');
  add(9,          true,  9,           'ERROR_INVALID_BLOCK',               'The storage control block address is invalid.', 'Win32');
  add(10,         true,  10,          'ERROR_BAD_ENVIRONMENT',             'The environment is incorrect.', 'Win32');
  add(11,         true,  11,          'ERROR_BAD_FORMAT',                  'An attempt was made to load a program with an incorrect format.', 'Win32');
  add(13,         true,  13,          'ERROR_INVALID_DATA',                'The data is invalid.', 'Win32');
  add(14,         true,  14,          'ERROR_OUTOFMEMORY',                 'Not enough storage is available to complete this operation.', 'Win32');
  add(15,         true,  15,          'ERROR_INVALID_DRIVE',               'The system cannot find the drive specified.', 'Win32');
  add(16,         true,  16,          'ERROR_CURRENT_DIRECTORY',           'The directory cannot be removed.', 'Win32');
  add(17,         true,  17,          'ERROR_NOT_SAME_DEVICE',             'The system cannot move the file to a different disk drive.', 'Win32');
  add(18,         true,  18,          'ERROR_NO_MORE_FILES',               'There are no more files.', 'Win32');
  add(19,         true,  19,          'ERROR_WRITE_PROTECT',               'The media is write protected.', 'Win32');
  add(20,         true,  20,          'ERROR_BAD_UNIT',                    'The system cannot find the device specified.', 'Win32');
  add(21,         true,  21,          'ERROR_NOT_READY',                   'The device is not ready.', 'Win32');
  add(22,         true,  22,          'ERROR_BAD_COMMAND',                 'The device does not recognize the command.', 'Win32');
  add(23,         true,  23,          'ERROR_CRC',                         'Data error (cyclic redundancy check).', 'Win32');
  add(24,         true,  24,          'ERROR_BAD_LENGTH',                  'The program issued a command but the command length is incorrect.', 'Win32');
  add(25,         true,  25,          'ERROR_SEEK',                        'The drive cannot locate a specific area or track on the disk.', 'Win32');
  add(32,         true,  32,          'ERROR_SHARING_VIOLATION',           'The process cannot access the file because it is being used by another process.', 'Win32');
  add(33,         true,  33,          'ERROR_LOCK_VIOLATION',              'The process cannot access the file because another process has locked a portion of the file.', 'Win32');
  add(36,         true,  36,          'ERROR_SHARING_BUFFER_EXCEEDED',     'Too many files opened for sharing.', 'Win32');
  add(38,         true,  38,          'ERROR_HANDLE_EOF',                  'Reached the end of the file.', 'Win32');
  add(39,         true,  39,          'ERROR_HANDLE_DISK_FULL',            'The disk is full.', 'Win32');
  add(50,         true,  50,          'ERROR_NOT_SUPPORTED',               'The request is not supported.', 'Win32');
  add(51,         true,  51,          'ERROR_REM_NOT_LIST',                'Windows cannot find the network path.', 'Win32');
  add(52,         true,  52,          'ERROR_DUP_NAME',                    'You were not connected because a duplicate name exists on the network.', 'Win32');
  add(53,         true,  53,          'ERROR_BAD_NETPATH',                 'The network path was not found.', 'Win32');
  add(54,         true,  54,          'ERROR_NETWORK_BUSY',                'The network is busy.', 'Win32');
  add(55,         true,  55,          'ERROR_DEV_NOT_EXIST',               'The specified network resource or device is no longer available.', 'Win32');
  add(57,         true,  57,          'ERROR_UNEXP_NET_ERR',               'An unexpected network error occurred.', 'Win32');
  add(58,         true,  58,          'ERROR_BAD_REM_ADAP',                'The specified server cannot perform the requested operation.', 'Win32');
  add(59,         true,  59,          'ERROR_PRINTQ_FULL',                 'The print queue is full.', 'Win32');
  add(64,         true,  64,          'ERROR_NETNAME_DELETED',             'The specified network name is no longer available.', 'Win32');
  add(65,         true,  65,          'ERROR_NETWORK_ACCESS_DENIED',       'Network access is denied.', 'Win32');
  add(67,         true,  67,          'ERROR_BAD_NET_NAME',                'The network name cannot be found.', 'Win32');
  add(80,         true,  80,          'ERROR_FILE_EXISTS',                 'The file exists.', 'Win32');
  add(82,         true,  82,          'ERROR_CANNOT_MAKE',                 'The directory or file cannot be created.', 'Win32');
  add(83,         true,  83,          'ERROR_FAIL_I24',                    'Fail on INT 24.', 'Win32');
  add(85,         true,  85,          'ERROR_ALREADY_ASSIGNED',            'The local device name is already in use.', 'Win32');
  add(86,         true,  86,          'ERROR_INVALID_PASSWORD',            'The specified network password is not correct.', 'Win32');
  add(87,         true,  87,          'ERROR_INVALID_PARAMETER',           'The parameter is incorrect.', 'Win32');
  add(88,         true,  88,          'ERROR_NET_WRITE_FAULT',             'A write fault occurred on the network.', 'Win32');
  add(112,        true,  112,         'ERROR_DISK_FULL',                   'There is not enough space on the disk.', 'Win32');
  add(120,        true,  120,         'ERROR_CALL_NOT_IMPLEMENTED',        'This function is not supported on this system.', 'Win32');
  add(121,        true,  121,         'ERROR_SEM_TIMEOUT',                 'The semaphore timeout period has expired.', 'Win32');
  add(122,        true,  122,         'ERROR_INSUFFICIENT_BUFFER',         'The data area passed to a system call is too small.', 'Win32');
  add(123,        true,  123,         'ERROR_INVALID_NAME',                'The filename, directory name, or volume label syntax is incorrect.', 'Win32');
  add(124,        true,  124,         'ERROR_INVALID_LEVEL',               'The system call level is not correct.', 'Win32');
  add(125,        true,  125,         'ERROR_NO_VOLUME_LABEL',             'The disk has no volume label.', 'Win32');
  add(127,        true,  127,         'ERROR_PROC_NOT_FOUND',              'The specified procedure could not be found.', 'Win32');
  add(128,        true,  128,         'ERROR_WAIT_NO_CHILDREN',            'There are no child processes to wait for.', 'Win32');
  add(145,        true,  145,         'ERROR_DIR_NOT_EMPTY',               'The directory is not empty.', 'Win32');
  add(161,        true,  161,         'ERROR_BAD_PATHNAME',                'The specified path is invalid.', 'Win32');
  add(162,        true,  162,         'ERROR_SIGNAL_PENDING',              'A signal is already pending.', 'Win32');
  add(164,        true,  164,         'ERROR_MAX_THRDS_REACHED',           'No more threads can be created in the system.', 'Win32');
  add(167,        true,  167,         'ERROR_LOCK_FAILED',                 'Unable to lock a region of a file.', 'Win32');
  add(170,        true,  170,         'ERROR_BUSY',                        'The requested resource is in use.', 'Win32');
  add(183,        true,  183,         'ERROR_ALREADY_EXISTS',              'Cannot create a file when that file already exists.', 'Win32');
  add(206,        true,  206,         'ERROR_FILENAME_EXCED_RANGE',        'The filename or extension is too long.', 'Win32');
  add(215,        true,  215,         'ERROR_NESTING_NOT_ALLOWED',         'Cannot nest calls to LoadModule.', 'Win32');
  add(225,        true,  225,         'ERROR_VIRUS_INFECTED',              'Operation did not complete successfully because the file contains a virus.', 'Win32');
  add(267,        true,  267,         'ERROR_DIRECTORY',                   'The directory name is invalid.', 'Win32');
  add(298,        true,  298,         'ERROR_TOO_MANY_POSTS',              'Too many posts were made to a semaphore.', 'Win32');
  add(299,        true,  299,         'ERROR_PARTIAL_COPY',                'Only part of a ReadProcessMemory or WriteProcessMemory request was completed.', 'Win32');
  add(317,        true,  317,         'ERROR_MR_MID_NOT_FOUND',            'The system cannot find message text for message number 0x%1 in the message file for %2.', 'Win32');
  add(487,        true,  487,         'ERROR_INVALID_ADDRESS',             'Attempt to access invalid address.', 'Win32');
  add(534,        true,  534,         'ERROR_ARITHMETIC_OVERFLOW',         'Arithmetic result exceeded 32 bits.', 'Win32');

  // Network / RPC errors
  add(1062,       true,  1062,        'ERROR_SERVICE_NOT_ACTIVE',          'The service has not been started.', 'Win32');
  add(1063,       true,  1063,        'ERROR_FAILED_SERVICE_CONTROLLER_CONNECT', 'The service process could not connect to the service controller.', 'Win32');
  add(1067,       true,  1067,        'ERROR_PROCESS_ABORTED',             'The process terminated unexpectedly.', 'Win32');
  add(1068,       true,  1068,        'ERROR_SERVICE_DEPENDENCY_FAIL',     'The dependency service or group failed to start.', 'Win32');
  add(1069,       true,  1069,        'ERROR_SERVICE_LOGON_FAILED',        'The service did not start due to a logon failure.', 'Win32');
  add(1070,       true,  1070,        'ERROR_SERVICE_START_HANG',          'After starting, the service hung in a start-pending state.', 'Win32');
  add(1077,       true,  1077,        'ERROR_SERVICE_NEVER_STARTED',       'No attempts to start the service have been made since the last boot.', 'Win32');
  add(1079,       true,  1079,        'ERROR_DIFFERENT_SERVICE_ACCOUNT',   'The account specified for this service is different from the account specified for other services running in the same process.', 'Win32');
  add(1130,       true,  1130,        'ERROR_NOT_ENOUGH_SERVER_MEMORY',    'Not enough server storage is available to process this command.', 'Win32');
  add(1167,       true,  1167,        'ERROR_DEVICE_NOT_CONNECTED',        'The device is not connected.', 'Win32');
  add(1168,       true,  1168,        'ERROR_NOT_FOUND',                   'Element not found.', 'Win32');
  add(1169,       true,  1169,        'ERROR_NO_MATCH',                    'There was no match for the specified key in the index.', 'Win32');
  add(1170,       true,  1170,        'ERROR_SET_NOT_FOUND',               'The property set specified does not exist on the object.', 'Win32');
  add(1224,       true,  1224,        'ERROR_USER_MAPPED_FILE',            'The requested operation cannot be performed on a file with a user-mapped section open.', 'Win32');
  add(1235,       true,  1235,        'ERROR_REQUEST_ABORTED',             'The request was aborted.', 'Win32');
  add(1237,       true,  1237,        'ERROR_CONNECTION_ABORTED',          'The network connection was aborted by the local system.', 'Win32');
  add(1260,       true,  1260,        'ERROR_ACCESS_DISABLED_BY_POLICY',   'This program is blocked by group policy. For more information, contact your system administrator.', 'Win32');
  add(1305,       true,  1305,        'ERROR_UNKNOWN_REVISION',            'The revision level is unknown.', 'Win32');
  add(1326,       true,  1326,        'ERROR_LOGON_FAILURE',               'The user name or password is incorrect.', 'Win32');
  add(1332,       true,  1332,        'ERROR_NONE_MAPPED',                 'No mapping between account names and security IDs was done.', 'Win32');
  add(1392,       true,  1392,        'ERROR_FILE_CORRUPT',                'The file or directory is corrupted and unreadable.', 'Win32');
  add(1400,       true,  1400,        'ERROR_INVALID_WINDOW_HANDLE',       'Invalid window handle.', 'Win32');
  add(1450,       true,  1450,        'ERROR_NO_SYSTEM_RESOURCES',         'Insufficient system resources exist to complete the requested service.', 'Win32');
  add(1453,       true,  1453,        'ERROR_COMMITMENT_LIMIT',            'Insufficient quota to complete the requested service.', 'Win32');
  add(1460,       true,  1460,        'ERROR_TIMEOUT',                     'This operation returned because the timeout period expired.', 'Win32');
  add(1461,       true,  1461,        'ERROR_SUCCESS_REBOOT_REQUIRED',     'The requested operation is successful. Changes will not be effective until the system is rebooted.', 'Win32');
  add(1462,       true,  1462,        'ERROR_SUCCESS_RESTART_REQUIRED',    'The requested operation is successful. Changes will not be effective until the service is restarted.', 'Win32');
  add(1500,       true,  1500,        'ERROR_REGISTRY_QUOTA_LIMIT',        'The system has attempted to load or restore a file into the registry, but the specified file is not in a registry file format.', 'Win32');
  add(1502,       true,  1502,        'ERROR_EVENTLOG_FILE_CORRUPT',       'One of the files in the Registry database had to be recovered by use of a log or alternate copy. The recovery was successful.', 'Win32');

  // -----------------------------------------------------------------------
  // MSI / Windows Installer error codes
  // -----------------------------------------------------------------------
  add(1601,  true,  1601,  'ERROR_INSTALL_SERVICE_FAILURE',   'The Windows Installer service could not be accessed. Contact your support personnel to verify that the Windows Installer service is properly registered.', 'MSI');
  add(1602,  true,  1602,  'ERROR_INSTALL_USEREXIT',          'User cancelled installation.', 'MSI');
  add(1603,  true,  1603,  'ERROR_INSTALL_FAILURE',           'Fatal error during installation.', 'MSI');
  add(1604,  true,  1604,  'ERROR_INSTALL_SUSPEND',           'Installation suspended, incomplete.', 'MSI');
  add(1605,  true,  1605,  'ERROR_UNKNOWN_PRODUCT',           'This action is only valid for products that are currently installed.', 'MSI');
  add(1606,  true,  1606,  'ERROR_UNKNOWN_FEATURE',           'Feature ID not registered.', 'MSI');
  add(1607,  true,  1607,  'ERROR_UNKNOWN_COMPONENT',         'Component ID not registered.', 'MSI');
  add(1608,  true,  1608,  'ERROR_UNKNOWN_PROPERTY',          'Unknown property.', 'MSI');
  add(1609,  true,  1609,  'ERROR_INVALID_HANDLE_STATE',      'Handle is in an invalid state.', 'MSI');
  add(1610,  true,  1610,  'ERROR_BAD_CONFIGURATION',         'The configuration data for this product is corrupt. Contact your support personnel.', 'MSI');
  add(1611,  true,  1611,  'ERROR_INDEX_ABSENT',              'Component qualifier not present.', 'MSI');
  add(1612,  true,  1612,  'ERROR_INSTALL_SOURCE_ABSENT',     'The installation source for this product is not available. Verify that the source exists and that you can access it.', 'MSI');
  add(1613,  true,  1613,  'ERROR_INSTALL_PACKAGE_VERSION',   'This installation package cannot be installed by the Windows Installer service. You must install a Windows service pack that contains a newer version of the Windows Installer service.', 'MSI');
  add(1614,  true,  1614,  'ERROR_PRODUCT_UNINSTALLED',       'Product is uninstalled.', 'MSI');
  add(1615,  true,  1615,  'ERROR_BAD_QUERY_SYNTAX',          'SQL query syntax invalid or unsupported.', 'MSI');
  add(1616,  true,  1616,  'ERROR_INVALID_FIELD',             'Record field does not exist.', 'MSI');
  add(1618,  true,  1618,  'ERROR_INSTALL_ALREADY_RUNNING',   'Another installation is already in progress. Complete that installation before proceeding with this install.', 'MSI');
  add(1619,  true,  1619,  'ERROR_INSTALL_PACKAGE_OPEN_FAILED','This installation package could not be opened. Verify that the package exists and that you can access it, or contact the application vendor to verify that this is a valid Windows Installer package.', 'MSI');
  add(1620,  true,  1620,  'ERROR_INSTALL_PACKAGE_INVALID',   'This installation package could not be opened. Contact the application vendor to verify that this is a valid Windows Installer package.', 'MSI');
  add(1621,  true,  1621,  'ERROR_INSTALL_UI_FAILURE',        'There was an error starting the Windows Installer service user interface. Contact your support personnel.', 'MSI');
  add(1622,  true,  1622,  'ERROR_INSTALL_LOG_FAILURE',       'Error opening installation log file. Verify that the specified log file location exists and is writable.', 'MSI');
  add(1623,  true,  1623,  'ERROR_INSTALL_LANGUAGE_UNSUPPORTED','The language of this installation package is not supported by your system.', 'MSI');
  add(1624,  true,  1624,  'ERROR_INSTALL_TRANSFORM_FAILURE', 'Error applying transforms. Verify that the specified transform paths are valid.', 'MSI');
  add(1625,  true,  1625,  'ERROR_INSTALL_PACKAGE_REJECTED',  'This installation is forbidden by system policy. Contact your system administrator.', 'MSI');
  add(1626,  true,  1626,  'ERROR_FUNCTION_NOT_CALLED',       'Function could not be executed.', 'MSI');
  add(1627,  true,  1627,  'ERROR_FUNCTION_FAILED',           'Function failed during execution.', 'MSI');
  add(1628,  true,  1628,  'ERROR_INVALID_TABLE',             'Invalid or unknown table specified.', 'MSI');
  add(1629,  true,  1629,  'ERROR_DATATYPE_MISMATCH',         'Data supplied is of wrong type.', 'MSI');
  add(1630,  true,  1630,  'ERROR_UNSUPPORTED_TYPE',          'Data of this type is not supported.', 'MSI');
  add(1631,  true,  1631,  'ERROR_CREATE_FAILED',             'The Windows Installer service failed to start. Contact your support personnel.', 'MSI');
  add(1632,  true,  1632,  'ERROR_INSTALL_TEMP_UNWRITABLE',   'The Temp folder is on a drive that is full or is inaccessible. Free up space on the drive or verify that you have write permission on the Temp folder.', 'MSI');
  add(1633,  true,  1633,  'ERROR_INSTALL_PLATFORM_UNSUPPORTED','This installation package is not supported by this processor type. Contact your product vendor.', 'MSI');
  add(1634,  true,  1634,  'ERROR_INSTALL_NOTUSED',           'Component not used on this computer.', 'MSI');
  add(1635,  true,  1635,  'ERROR_PATCH_PACKAGE_OPEN_FAILED', 'This update package could not be opened. Verify that the update package exists and that you can access it, or contact the application vendor to verify that this is a valid Windows Installer update package.', 'MSI');
  add(1636,  true,  1636,  'ERROR_PATCH_PACKAGE_INVALID',     'This update package could not be opened. Contact the application vendor to verify that this is a valid Windows Installer update package.', 'MSI');
  add(1637,  true,  1637,  'ERROR_PATCH_PACKAGE_UNSUPPORTED', 'This update package cannot be processed by the Windows Installer service. You must install a Windows service pack that contains a newer version of the Windows Installer service.', 'MSI');
  add(1638,  true,  1638,  'ERROR_PRODUCT_VERSION',           'Another version of this product is already installed. Installation of this version cannot continue. To configure or remove the existing version of this product, use Add/Remove Programs on the Control Panel.', 'MSI');
  add(1639,  true,  1639,  'ERROR_INVALID_COMMAND_LINE',      'Invalid command line argument. Consult the Windows Installer SDK for detailed command line help.', 'MSI');
  add(1640,  true,  1640,  'ERROR_INSTALL_REMOTE_DISALLOWED', 'Only administrators have permission to add, remove, or configure server software during a Terminal services remote session. If you want to install or configure software on the server, contact your network administrator.', 'MSI');
  add(1641,  true,  1641,  'ERROR_SUCCESS_REBOOT_INITIATED',  'The installer has initiated a restart. This message is indicative of a success.', 'MSI');
  add(1642,  true,  1642,  'ERROR_PATCH_TARGET_NOT_FOUND',    'The installer cannot install the upgrade patch because the program being upgraded may be missing, or the upgrade patch may update a different version of the program.', 'MSI');
  add(1643,  true,  1643,  'ERROR_PATCH_PACKAGE_REJECTED',    'The update patch cannot be installed by the Windows Installer service because the program to be upgraded may be missing, or the update patch may update a different version of the program.', 'MSI');
  add(1644,  true,  1644,  'ERROR_INSTALL_TRANSFORM_REJECTED','One or more customizations are not permitted by system policy.', 'MSI');
  add(1645,  true,  1645,  'ERROR_INSTALL_REMOTE_PROHIBITED', 'Windows Installer does not permit installation from a Remote Desktop Connection.', 'MSI');
  add(3010,  true,  3010,  'ERROR_SUCCESS_REBOOT_REQUIRED',   'A restart is required to complete the install. This does not include installs where the ForceReboot action is run.', 'MSI');
  add(3011,  true,  3011,  'ERROR_SUCCESS_REBOOT_INITIATED',  'The restart required is being initiated. The installer has queued a restart.', 'MSI');

  // -----------------------------------------------------------------------
  // Common HRESULT codes — stored under both unsigned decimal and 0x-hex keys.
  // For HRESULT the signed int32 interpretation is the negative value.
  // -----------------------------------------------------------------------

  // Generic HRESULT
  add(0x80004001, true, -2147467263, 'E_NOTIMPL',              'Not implemented.', 'HRESULT');
  add(0x80004002, true, -2147467262, 'E_NOINTERFACE',          'No such interface supported.', 'HRESULT');
  add(0x80004003, true, -2147467261, 'E_POINTER',              'Invalid pointer.', 'HRESULT');
  add(0x80004004, true, -2147467260, 'E_ABORT',                'Operation aborted.', 'HRESULT');
  add(0x80004005, true, -2147467259, 'E_FAIL',                 'Unspecified error.', 'HRESULT');

  // Win32-wrapped HRESULTs (0x8007xxxx = FACILITY_WIN32)
  add(0x80070002, true, -2147024894, 'HRESULT_ERROR_FILE_NOT_FOUND',   'The system cannot find the file specified. (Win32: 0x2)', 'HRESULT');
  add(0x80070003, true, -2147024893, 'HRESULT_ERROR_PATH_NOT_FOUND',   'The system cannot find the path specified. (Win32: 0x3)', 'HRESULT');
  add(0x80070005, true, -2147024891, 'HRESULT_ERROR_ACCESS_DENIED',    'Access is denied. (Win32: 0x5)', 'HRESULT');
  add(0x80070006, true, -2147024890, 'HRESULT_ERROR_INVALID_HANDLE',   'The handle is invalid. (Win32: 0x6)', 'HRESULT');
  add(0x8007000B, true, -2147024885, 'HRESULT_ERROR_BAD_FORMAT',       'An attempt was made to load a program with an incorrect format.', 'HRESULT');
  add(0x8007000D, true, -2147024883, 'HRESULT_ERROR_INVALID_DATA',     'The data is invalid.', 'HRESULT');
  add(0x8007000E, true, -2147024882, 'HRESULT_ERROR_OUTOFMEMORY',      'Not enough storage is available to complete this operation. (Win32: 0xE)', 'HRESULT');
  add(0x80070020, true, -2147024864, 'HRESULT_ERROR_SHARING_VIOLATION','The process cannot access the file because it is being used by another process. (Win32: 0x20)', 'HRESULT');
  add(0x80070035, true, -2147024843, 'HRESULT_ERROR_BAD_NETPATH',      'The network path was not found. (Win32: 0x35)', 'HRESULT');
  add(0x80070050, true, -2147024816, 'HRESULT_ERROR_FILE_EXISTS',      'The file exists. (Win32: 0x50)', 'HRESULT');
  add(0x80070057, true, -2147024809, 'HRESULT_ERROR_INVALID_PARAMETER','The parameter is incorrect. (Win32: 0x57)', 'HRESULT');
  add(0x80070070, true, -2147024784, 'HRESULT_ERROR_DISK_FULL',        'There is not enough space on the disk. (Win32: 0x70)', 'HRESULT');
  add(0x80070091, true, -2147024751, 'HRESULT_ERROR_DIR_NOT_EMPTY',    'The directory is not empty. (Win32: 0x91)', 'HRESULT');
  add(0x800700B7, true, -2147024713, 'HRESULT_ERROR_ALREADY_EXISTS',   'Cannot create a file when that file already exists. (Win32: 0xB7)', 'HRESULT');
  add(0x800705B4, true, -2147023436, 'HRESULT_ERROR_TIMEOUT',          'This operation returned because the timeout period expired. (Win32: 0x5B4)', 'HRESULT');
  add(0x80070643, true, -2147023293, 'HRESULT_ERROR_INSTALL_FAILURE',  'Fatal error during installation. (Win32: 0x643)', 'HRESULT');
  add(0x80070652, true, -2147023278, 'HRESULT_ERROR_INSTALL_ALREADY_RUNNING', 'Another installation is already in progress. (Win32: 0x652)', 'HRESULT');
  add(0x80070661, true, -2147023263, 'HRESULT_ERROR_PRODUCT_VERSION',  'Another version of this product is already installed. (Win32: 0x661)', 'HRESULT');
  add(0x80070BC2, true, -2147022910, 'HRESULT_ERROR_SUCCESS_REBOOT_REQUIRED', 'A reboot is required. (Win32: 0xBC2)', 'HRESULT');

  // -----------------------------------------------------------------------
  // Windows Update (WU) error codes — 0x8024xxxx
  // -----------------------------------------------------------------------
  add(0x80240001, true, -2145124351, 'WU_E_NO_SERVICE',                  'Windows Update Agent was unable to provide the service.', 'WU');
  add(0x80240002, true, -2145124350, 'WU_E_MAX_CAPACITY_REACHED',        'The maximum capacity of the service was exceeded.', 'WU');
  add(0x80240003, true, -2145124349, 'WU_E_UNKNOWN_ID',                  'An ID cannot be found.', 'WU');
  add(0x80240004, true, -2145124348, 'WU_E_NOT_INITIALIZED',             'The object could not be initialized.', 'WU');
  add(0x80240005, true, -2145124347, 'WU_E_RANGEOVERLAP',                'The update handler requested a byte range overlapping a previously requested range.', 'WU');
  add(0x80240006, true, -2145124346, 'WU_E_TOOMANYRANGES',               'The requested number of byte ranges exceeds the maximum number.', 'WU');
  add(0x80240007, true, -2145124345, 'WU_E_INVALIDINDEX',                'The index to a collection was invalid.', 'WU');
  add(0x80240008, true, -2145124344, 'WU_E_ITEMNOTFOUND',                'The key for the item queried could not be found.', 'WU');
  add(0x80240009, true, -2145124343, 'WU_E_OPERATIONINPROGRESS',         'Another conflicting operation was in progress.', 'WU');
  add(0x8024000A, true, -2145124342, 'WU_E_COULDNOTCANCEL',              'Cancellation of the operation was not allowed.', 'WU');
  add(0x8024000B, true, -2145124341, 'WU_E_CALL_CANCELLED',              'Operation was cancelled.', 'WU');
  add(0x8024000C, true, -2145124340, 'WU_E_NOOP',                        'No operation was required.', 'WU');
  add(0x8024000D, true, -2145124339, 'WU_E_XML_MISSINGDATA',             'Windows Update Agent could not find required information in the update\'s XML data.', 'WU');
  add(0x8024000E, true, -2145124338, 'WU_E_XML_INVALID',                 'Windows Update Agent found invalid information in the update\'s XML data.', 'WU');
  add(0x8024000F, true, -2145124337, 'WU_E_CYCLE_DETECTED',              'Circular update relationships were detected in the metadata.', 'WU');
  add(0x80240010, true, -2145124336, 'WU_E_TOO_DEEP_RELATION',           'Update relationships too deep to evaluate were evaluated.', 'WU');
  add(0x80240011, true, -2145124335, 'WU_E_INVALID_RELATIONSHIP',        'An invalid update relationship was detected.', 'WU');
  add(0x80240012, true, -2145124334, 'WU_E_REG_VALUE_INVALID',           'An invalid registry value was read.', 'WU');
  add(0x80240016, true, -2145124330, 'WU_E_INSTALL_NOT_ALLOWED',         'Operation tried to install while another installation was in progress or the system was pending a mandatory restart.', 'WU');
  add(0x80240017, true, -2145124329, 'WU_E_NOT_APPLICABLE',              'The operation is not applicable.', 'WU');
  add(0x80240018, true, -2145124328, 'WU_E_NO_USERTOKEN',                'Operation failed because a required user token is missing.', 'WU');
  add(0x80240020, true, -2145124320, 'WU_E_NO_INTERACTIVE_USER',         'Operation did not complete because there is no logged-on interactive user.', 'WU');
  add(0x80240021, true, -2145124319, 'WU_E_TIME_OUT',                    'Operation did not complete because it timed out.', 'WU');
  add(0x80240022, true, -2145124318, 'WU_E_ALL_UPDATES_FAILED',          'Operation failed for all the updates.', 'WU');
  add(0x80240023, true, -2145124317, 'WU_E_EULAS_DECLINED',              'The license terms for all updates were declined.', 'WU');
  add(0x80240024, true, -2145124316, 'WU_E_NO_UPDATE',                   'There are no updates.', 'WU');
  add(0x80240025, true, -2145124315, 'WU_E_USER_ACCESS_DISABLED',        'Group Policy settings prevented access to Windows Update.', 'WU');
  add(0x80240026, true, -2145124314, 'WU_E_INVALID_UPDATE_TYPE',         'The type of update is invalid.', 'WU');
  add(0x80240029, true, -2145124311, 'WU_E_INVALID_PRODUCT_LICENSE',     'Search may have missed some updates because the Windows Update Agent could not parse the license terms for a product.', 'WU');
  add(0x8024002A, true, -2145124310, 'WU_E_MISSING_HANDLER',             'A component required to detect applicable updates was missing.', 'WU');
  add(0x8024002B, true, -2145124309, 'WU_E_LEGACYSERVER',                'An operation did not complete because it requires a newer version of server.', 'WU');
  add(0x8024002C, true, -2145124308, 'WU_E_BIN_SOURCE_ABSENT',           'A delta-compressed update could not be installed because it required the source.', 'WU');
  add(0x8024002D, true, -2145124307, 'WU_E_SOURCE_ABSENT',               'A full-file update could not be installed because it required the source.', 'WU');
  add(0x8024002E, true, -2145124306, 'WU_E_WU_DISABLED',                 'Access to an unmanaged server is not allowed.', 'WU');
  add(0x8024002F, true, -2145124305, 'WU_E_CALL_CANCELLED_BY_POLICY',    'Operation did not complete because the DisableWindowsUpdateAccess policy was set.', 'WU');
  add(0x80240030, true, -2145124304, 'WU_E_INVALID_PROXY_SERVER',        'The format of the proxy list was invalid.', 'WU');
  add(0x80240031, true, -2145124303, 'WU_E_INVALID_FILE',                'The file is in the wrong format.', 'WU');
  add(0x80240032, true, -2145124302, 'WU_E_INVALID_CRITERIA',            'The search criteria string was invalid.', 'WU');
  add(0x80240033, true, -2145124301, 'WU_E_EULA_UNAVAILABLE',            'License terms could not be downloaded.', 'WU');
  add(0x80240034, true, -2145124300, 'WU_E_DOWNLOAD_FAILED',             'Update failed to download.', 'WU');
  add(0x80240035, true, -2145124299, 'WU_E_UPDATE_NOT_PROCESSED',        'The update was not processed.', 'WU');
  add(0x80240036, true, -2145124298, 'WU_E_INVALID_OPERATION',           'The object\'s current state did not allow the operation.', 'WU');
  add(0x80240037, true, -2145124297, 'WU_E_NOT_SUPPORTED',               'The functionality for the operation is not supported.', 'WU');
  add(0x80240038, true, -2145124296, 'WU_E_WINHTTP_INVALID_FILE',        'The downloaded file has an unexpected content type.', 'WU');
  add(0x80240039, true, -2145124295, 'WU_E_TOO_MANY_RESYNC',             'Agent is asked by server to resync too many times.', 'WU');
  add(0x80240040, true, -2145124288, 'WU_E_NO_SERVER_CORE_SUPPORT',      'WUA API method does not run on Server Core installation.', 'WU');
  add(0x80240041, true, -2145124287, 'WU_E_SYSPREP_IN_PROGRESS',         'Service is still running when per-machine operation is to be blocked by sysprep.', 'WU');
  add(0x80240042, true, -2145124286, 'WU_E_UNKNOWN_SERVICE',             'The update service is no longer registered with AU.', 'WU');
  add(0x80240FFF, true, -2145120257, 'WU_E_UNEXPECTED',                  'A Windows Update Agent operation failed due to reasons not covered by another error code.', 'WU');

  // WUAgent HTTP codes
  add(0x80244000, true, -2145107968, 'WU_E_PT_SOAPCLIENT_BASE',          'WU_E_PT_SOAPCLIENT_* error codes map to the SOAPCLIENT_ERROR enum of the ATL Server Library.', 'WU');
  add(0x80244002, true, -2145107966, 'WU_E_PT_SOAPCLIENT_OUTOFMEMORY',   'SOAP client failed because it ran out of memory.', 'WU');
  add(0x8024402C, true, -2145107924, 'WU_E_PT_WINHTTP_NAME_NOT_RESOLVED','The proxy server or target server name cannot be resolved.', 'WU');
  add(0x8024402F, true, -2145107921, 'WU_E_PT_ECP_SUCCEEDED_WITH_ERRORS','External cab file processing completed with some errors.', 'WU');

  // -----------------------------------------------------------------------
  // SCCM / ConfigMgr client error codes — 0x87Dxxxxx
  // -----------------------------------------------------------------------
  add(0x87D00231, true, -2016409039, 'SCCM_E_CIDOWNLOADFAILED',          'Content download failed.', 'SCCM');
  add(0x87D00269, true, -2016408983, 'SCCM_E_CINOTFOUND',                'The CI (configuration item) was not found.', 'SCCM');
  add(0x87D00280, true, -2016408960, 'SCCM_E_CINOTREADY',                'The CI is not ready.', 'SCCM');
  add(0x87D00314, true, -2016408812, 'SCCM_E_REQUISITION_FAILED',        'The requisition failed.', 'SCCM');
  add(0x87D00315, true, -2016408811, 'SCCM_E_PREREQUISITE_FAILED',       'A prerequisite check failed.', 'SCCM');
  add(0x87D00324, true, -2016408796, 'SCCM_E_APPDOWNLOAD_FAILED',        'Application download failed.', 'SCCM');
  add(0x87D00327, true, -2016408793, 'SCCM_E_APPINSTALL_FAILED',         'Application install failed.', 'SCCM');
  add(0x87D0032D, true, -2016408787, 'SCCM_E_DETECTION_FAILED',          'Detection of the application failed after installation.', 'SCCM');
  add(0x87D00607, true, -2016408057, 'SCCM_E_MISSING_CONTENT',           'Content required for the deployment is missing.', 'SCCM');
  add(0x87D00667, true, -2016408473, 'SCCM_E_SOFTWARE_UPDATE_STILL_PENDING', 'The software update is still pending execution.', 'SCCM');
  add(0x87D00668, true, -2016408472, 'SCCM_E_SOFTWARE_UPDATE_EXECUTE_FAILURE', 'Software update execution failed.', 'SCCM');
  add(0x87D00669, true, -2016408471, 'SCCM_E_SOFTWARE_UPDATE_EVALUATE_FAILURE', 'Failed to evaluate software update enforcement.', 'SCCM');
  add(0x87D0070C, true, -2016408308, 'SCCM_E_POLICY_NOT_FOUND',          'Policy was not found.', 'SCCM');
  add(0x87D0070D, true, -2016408307, 'SCCM_E_POLICY_EXPIRED',            'Policy has expired.', 'SCCM');
  add(0x87D01004, true, -2016407548, 'SCCM_E_NOMAINTENANCEWINDOW',       'The deployment action could not run because no maintenance window was available.', 'SCCM');
  add(0x87D01006, true, -2016407546, 'SCCM_E_UNINSTRUMENTEDSCRIPT',      'Script execution was skipped because the script is not instrumented.', 'SCCM');
  add(0x87D01012, true, -2016407534, 'SCCM_E_AGENT_TIMEDOUT',            'The management agent timed out waiting for the operation.', 'SCCM');
  add(0x87D01106, true, -2016407290, 'SCCM_E_TS_DOWNLOADFAILED',         'Task sequence content download failed.', 'SCCM');
  add(0x87D0131A, true, -2016407270, 'SCCM_E_MACHINE_POLICY_NOT_FOUND',  'Machine policy was not found.', 'SCCM');
  add(0x87D01327, true, -2016406745, 'SCCM_E_TS_PREREQ_FAILED',          'Task sequence prerequisite failed.', 'SCCM');
  add(0x87D01338, true, -2016406728, 'SCCM_E_TS_CANCELED',               'Task sequence was cancelled.', 'SCCM');
  add(0x87D0134C, true, -2016406708, 'SCCM_E_TS_ACTION_FAILED',          'A task sequence action failed.', 'SCCM');
  add(0x87D0135C, true, -2016406692, 'SCCM_E_TS_VARIABLE_NOT_SET',       'A required task sequence variable was not set.', 'SCCM');
  add(0x87D01384, true, -2016406652, 'SCCM_E_TS_RUN_FAILED',             'Task sequence run failed.', 'SCCM');
  add(0x87D02003, true, -2016405501, 'SCCM_E_INSTALL_COMPLIANCE_FAILED', 'Compliance installation failed.', 'SCCM');
  add(0x87D02005, true, -2016405499, 'SCCM_E_REMEDIATION_FAILED',        'Remediation failed.', 'SCCM');

  // -----------------------------------------------------------------------
  // Additional commonly encountered codes
  // -----------------------------------------------------------------------
  // WMI / RPC / DCOM
  add(0x80041001, true, -2147217407, 'WBEM_E_FAILED',                    'Call failed.', 'HRESULT');
  add(0x80041002, true, -2147217406, 'WBEM_E_NOT_FOUND',                 'Object cannot be found.', 'HRESULT');
  add(0x80041003, true, -2147217405, 'WBEM_E_ACCESS_DENIED',             'Current user does not have permission to perform the action.', 'HRESULT');
  add(0x80041006, true, -2147217402, 'WBEM_E_OUT_OF_MEMORY',             'Not enough memory for the operation.', 'HRESULT');
  add(0x80041010, true, -2147217392, 'WBEM_E_INVALID_CLASS',             'Specified class is not valid.', 'HRESULT');
  add(0x80041017, true, -2147217385, 'WBEM_E_NOT_SUPPORTED',             'Provider does not support the requested put operation.', 'HRESULT');
  add(0x80041032, true, -2147217358, 'WBEM_E_CALL_CANCELLED',            'Asynchronous call was cancelled.', 'HRESULT');
  add(0x80080005, true, -2146959355, 'CO_E_SERVER_EXEC_FAILURE',         'Server execution failed.', 'HRESULT');
  add(0x800706BA, true, -2147023174, 'RPC_S_SERVER_UNAVAILABLE',         'The RPC server is unavailable.', 'HRESULT');
  add(0x800706BE, true, -2147023170, 'RPC_S_CALL_FAILED',                'The remote procedure call failed.', 'HRESULT');
  add(0x800706BF, true, -2147023169, 'RPC_S_CALL_FAILED_DNE',            'The remote procedure call failed and did not execute.', 'HRESULT');
  add(0x800706C6, true, -2147023162, 'RPC_X_BAD_STUB_DATA',              'The stub received bad data.', 'HRESULT');

  // Security / Crypto
  add(0x8009000B, true, -2146893813, 'NTE_BAD_KEY_STATE',                'Key not valid for use in specified state.', 'HRESULT');
  add(0x8009001F, true, -2146893793, 'NTE_NO_MEMORY',                    'Insufficient memory available for the operation.', 'HRESULT');
  add(0x80090020, true, -2146893792, 'NTE_EXISTS',                       'Object already exists.', 'HRESULT');
  add(0x80090305, true, -2146893051, 'SEC_E_SECPKG_NOT_FOUND',           'The requested security package does not exist.', 'HRESULT');
  add(0x8009030C, true, -2146893044, 'SEC_E_LOGON_DENIED',               'The logon attempt failed.', 'HRESULT');
  add(0x80090311, true, -2146893039, 'SEC_E_NO_AUTHENTICATING_AUTHORITY','No authority could be contacted for authentication.', 'HRESULT');
  add(0x80090322, true, -2146893022, 'SEC_E_WRONG_PRINCIPAL',            'The target principal name is incorrect.', 'HRESULT');

  // TLS / certificate
  add(0x80072EFE, true, -2147012866, 'WININET_E_CONNECTION_ABORTED',     'The connection with the server has been terminated.', 'HRESULT');
  add(0x80072EFF, true, -2147012865, 'WININET_E_CONNECTION_RESET',       'The connection with the server was reset.', 'HRESULT');
  add(0x80072F05, true, -2147012859, 'WININET_E_DECODING_FAILED',        'Content decoding has failed.', 'HRESULT');
  add(0x80072F06, true, -2147012858, 'WININET_E_NOT_REDIRECTED',         'The request needs to be redirected but the redirection failed.', 'HRESULT');
  add(0x80072F08, true, -2147012856, 'WININET_E_SERVER_UNREACHABLE',     'The designated server could not be reached.', 'HRESULT');
  add(0x80072EE7, true, -2147012889, 'WININET_E_NAME_NOT_RESOLVED',      'The server name or address could not be resolved.', 'HRESULT');
  add(0x80072EE2, true, -2147012894, 'WININET_E_TIMEOUT',                'The operation timed out.', 'HRESULT');
  add(0x80072EFD, true, -2147012867, 'WININET_E_CANNOT_CONNECT',         'A connection with the server could not be established.', 'HRESULT');

  // BITS
  add(0x80190194, true, -2145844844, 'BG_E_HTTP_ERROR_404',              'BITS: HTTP 404 - file not found on the server.', 'HRESULT');
  add(0x80190193, true, -2145844845, 'BG_E_HTTP_ERROR_403',              'BITS: HTTP 403 - access forbidden.', 'HRESULT');
  add(0x80190191, true, -2145844847, 'BG_E_HTTP_ERROR_401',              'BITS: HTTP 401 - authentication required.', 'HRESULT');
  add(0x801900C9, true, -2145844919, 'BG_E_HTTP_ERROR_201',              'BITS: HTTP 201 - created (unexpected by BITS in error context).', 'HRESULT');
  add(0x8019012C, true, -2145844948, 'BG_E_HTTP_ERROR_300',              'BITS: HTTP 300 - multiple choices.', 'HRESULT');

  // Attach to CMT namespace
  window.CMT.errorCodes = codes;

}());
