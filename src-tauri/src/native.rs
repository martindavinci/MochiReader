// SPDX-License-Identifier: GPL-3.0-or-later
//! The Windows calls the app needs and Tauri does not offer.
use std::ffi::c_void;
use std::mem::size_of;
use windows::core::{w, BOOL, HSTRING};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

// ShellExecuteW answers with a value above this when it succeeds.
const SHELL_EXECUTE_LAST_ERROR: isize = 32;
const BOOT_GATE_NAME: &str = "io.github.martindavinci.mochireader-boot";
const BOOT_GATE_TIMEOUT_MS: u32 = 10_000;

/// Turns off the fade Windows plays when the window opens, which keeps the text faint for about 270 ms.
pub fn disable_open_animation(hwnd: HWND) -> windows::core::Result<()> {
    let disabled = BOOL::from(true);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            (&raw const disabled).cast::<c_void>(),
            size_of::<BOOL>() as u32,
        )
    }
}

/// Opens a URL in the program the system has for it.
pub fn shell_open(url: &str) -> Result<(), String> {
    let target = HSTRING::from(url);
    let result = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    if result.0 as isize > SHELL_EXECUTE_LAST_ERROR {
        Ok(())
    } else {
        Err(format!(
            "the system could not open it ({})",
            result.0 as isize
        ))
    }
}

/// Lets one process at a time through the start of the app.
///
/// The single instance plugin takes its mutex, then creates the window others send their files to.
/// A process that finds the mutex taken but the window not there yet would carry on as a second app,
/// with its own window: this is what happens when several files are opened at once in Explorer.
/// Hold this until the plugin is set up, and the window is always there.
pub struct BootGate(HANDLE);

impl BootGate {
    /// Waits for the process ahead. Past the limit the start goes on anyway: a stuck process must not
    /// keep the file from opening. `None` means the gate could not be made, and the same goes.
    pub fn acquire() -> Option<Self> {
        let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(BOOT_GATE_NAME)) }.ok()?;
        // An abandoned wait also grants the mutex: the process ahead exited, as a second instance does.
        unsafe { WaitForSingleObject(handle, BOOT_GATE_TIMEOUT_MS) };
        Some(Self(handle))
    }
}

impl Drop for BootGate {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
