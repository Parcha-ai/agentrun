# Code adapted from scrcpy

Parts of phoned's Android layer (`src/android/java/ai/agentrun/phoned/android/`) are adapted from
[scrcpy](https://github.com/Genymobile/scrcpy), Copyright (C) 2018 Genymobile and Copyright (C) 2018-2026 Romain Vimont,
licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Each adapted file says
so in its header.

Two scrcpy commits were read:

- `a60891aea193d92e7e5c3942700eca63f9d19a5f` (master, 2026-10-08), called "master" below.
- `665ccb32f5306ebd866dc0d99f4d08ed2aeb91c3` (tag v2.7), called "v2.7" below. Newer scrcpy reaches the clipboard and
  input through the public managers on a FakeContext; v2.7 still has the IClipboard and InputManagerGlobal wrappers
  phoned uses.

Paths are under `server/src/main/java/com/genymobile/scrcpy/`.

| phoned file | scrcpy file | commit | what changed |
| --- | --- | --- | --- |
| `Hidden.java` | `wrappers/ServiceManager.java` | master | Only `getService` + `Stub.asInterface`, returning null instead of throwing. Added `widest()`, which picks the AIDL method by name and lets the caller fill its arguments by type, in place of scrcpy's per-signature tables. |
| `Workarounds.java` | `Workarounds.java`, `Server.java` (`prepareMainLooper`) | master | Same ActivityThread, AppBindData, ConfigurationController and Application steps. Every step catches and logs instead of throwing AssertionError. The AudioRecord workaround is left out. |
| `FakeContext.java` | `FakeContext.java` | master | Keeps the `com.android.shell` package name, `getDeviceId()`, and the application and package context overrides. Left out: the ContentResolver override (it needs `IContentProvider`), `getAttributionSource()` (the API 30 SDK has no `AttributionSource`), and the `getSystemService` mContext patch. `get()` returns null when no system context could be built. |
| `Clipboard.java` | `wrappers/ClipboardManager.java` | v2.7 | Same IClipboard service and `com.android.shell` caller. scrcpy's signature table for `getPrimaryClip` and `setPrimaryClip` is replaced by filling the widest method's arguments by type, which gives the same arguments for each row of that table and also covers the device id from Android 14. Added `clearPrimaryClip` and the SystemUI `SUPPRESS_CLIPBOARD_OVERLAY` extra. Clipboard listeners are left out. |
| `PhoneInput.java` | `wrappers/InputManager.java` | v2.7 | Same `InputManagerGlobal.getInstance()` (Android 14+) or `InputManager.getInstance()`, `injectInputEvent(InputEvent, int)`, and the mode constants. `setDisplayId` is resolved once. A refusal throws an RpcError instead of logging. |
| `PhoneInput.java` | `device/Device.java` (`injectKeyEvent`), `control/Controller.java` (`injectChar`, pointer setup, `setClipboard` paste) | master | KeyEvent built the same way (VIRTUAL_KEYBOARD, SOURCE_KEYBOARD); `KeyCharacterMap.getEvents` for typing, without scrcpy's accent decomposition. The touch interpolation, pinch, and clipboard restore after a paste are phoned's own. |
| `PhoneApps.java` | `wrappers/ActivityManager.java` (`create`, `startActivity`, `forceStopPackage`) | master | Same `ActivityManagerNative.getDefault()`, `startActivityAsUser` signature and arguments, and `USER_CURRENT`. The START_* result is turned into an RpcError, and `am start` / `am force-stop` run as argv when the method is missing. |
| `PhoneApps.java` | `device/Device.java` (`getLaunchIntent`, `startApp`) | master | Launch intent from `getLaunchIntentForPackage`, then the leanback one, with `FLAG_ACTIVITY_NEW_TASK`; phoned adds `FLAG_ACTIVITY_CLEAR_TASK`. Listing uses `queryIntentActivities(MAIN/LAUNCHER)` instead of scrcpy's scan of every installed application. |
| `AndroidDevice.java` | `wrappers/DisplayManager.java` (`create`, `getDisplayInfo`) | master | Same `DisplayManagerGlobal.getDisplayInfo(0)` fields (`logicalWidth`, `logicalHeight`, `rotation`, `logicalDensityDpi`). Falls back to the public `Display` API instead of parsing `dumpsys display`. |
| `Main.java` | `Server.java` (`main`) | master | Same main looper preparation, Workarounds, and `System.exit` at the end. stdout is kept for protocol lines and `System.out` is pointed at stderr. |

No code was taken from these, though they were read:

- YADB (LGPL-3.0): its `layout/LayoutShell.java` shows the UiAutomation-from-app_process pattern.
- AOSP `UiAutomation.java`, `UiAutomationConnection.java`, `IActivityTaskManager.aidl`, `IClipboard.aidl`, and SystemUI
  `ClipboardListener.java` (Apache-2.0): read for the Android 11 to 16 constructors and signatures that `Ax.java`,
  `PhoneApps.java` and `Clipboard.java` call through reflection.
