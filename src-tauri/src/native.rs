// SPDX-License-Identifier: GPL-3.0-or-later
//! The Windows calls the app needs and Tauri does not offer.
use crate::state::WindowPlacement;
use std::ffi::c_void;
use std::fmt::Write as _;
use std::io::{self, Read};
use std::mem::size_of;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Settings3,
};
use windows::core::{w, Interface, BOOL, HSTRING};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::Security::Cryptography::{
    BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData, BCRYPT_HASH_HANDLE,
    BCRYPT_SHA256_ALG_HANDLE,
};
use windows::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPlacement, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWNORMAL,
    WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
};

// ShellExecuteW answers with a value above this when it succeeds.
const SHELL_EXECUTE_LAST_ERROR: isize = 32;
const BOOT_GATE_NAME: &str = "io.github.martindavinci.mochireader-boot";
const BOOT_GATE_TIMEOUT_MS: u32 = 10_000;
const SHA256_BYTES: usize = 32;
const HASH_READ_BYTES: usize = 64 * 1024;

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

/// Where the window goes when it is neither maximized nor minimized, and whether it is maximized now.
/// Windows keeps this however the window is showing, which the Tauri calls do not offer.
pub fn window_placement(hwnd: HWND) -> Option<WindowPlacement> {
    let mut placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &raw mut placement) }.ok()?;
    let rect = placement.rcNormalPosition;
    let restores_maximized = placement.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0;
    Some(WindowPlacement {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        maximized: placement.showCmd == SW_SHOWMAXIMIZED.0 as u32 || restores_maximized,
    })
}

/// Puts a window that is still hidden back where it was, and leaves it hidden. Windows itself moves it onto the
/// screen if it would land off every monitor, as after a monitor was unplugged.
pub fn set_window_placement(hwnd: HWND, placed: WindowPlacement) {
    if placed.width <= 0 || placed.height <= 0 {
        return;
    }
    let placement = WINDOWPLACEMENT {
        length: size_of::<WINDOWPLACEMENT>() as u32,
        showCmd: SW_HIDE.0 as u32,
        rcNormalPosition: RECT {
            left: placed.x,
            top: placed.y,
            right: placed.x + placed.width,
            bottom: placed.y + placed.height,
        },
        ..Default::default()
    };
    let _ = unsafe { SetWindowPlacement(hwnd, &raw const placement) };
}

/// Turns off what WebView2 does as a browser: Ctrl+R or F5 would reload the page and lose every tab, and the
/// right click menu offers the same. Tauri has no option for these. The page still receives the keys.
pub fn disable_browser_features(controller: &ICoreWebView2Controller) -> windows::core::Result<()> {
    unsafe {
        let settings = controller.CoreWebView2()?.Settings()?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    }
}

/// Ends the hash however the reading goes.
struct HashHandle(BCRYPT_HASH_HANDLE);

impl Drop for HashHandle {
    fn drop(&mut self) {
        let _ = unsafe { BCryptDestroyHash(self.0) };
    }
}

/// The SHA-256 of everything `reader` holds, in lower case hexadecimal. Windows has it, so the app does not ship it.
pub fn sha256(mut reader: impl Read) -> io::Result<String> {
    let mut handle = BCRYPT_HASH_HANDLE::default();
    unsafe { BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &raw mut handle, None, None, 0) }
        .ok()
        .map_err(io::Error::other)?;
    let handle = HashHandle(handle);
    let mut buffer = vec![0; HASH_READ_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        unsafe { BCryptHashData(handle.0, &buffer[..read], 0) }
            .ok()
            .map_err(io::Error::other)?;
    }
    let mut digest = [0; SHA256_BYTES];
    unsafe { BCryptFinishHash(handle.0, &mut digest, 0) }
        .ok()
        .map_err(io::Error::other)?;
    let mut text = String::with_capacity(SHA256_BYTES * 2);
    for byte in digest {
        let _ = write!(text, "{byte:02x}");
    }
    Ok(text)
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

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_INPUT_BYTES: usize = 1_000_000;

    #[test]
    fn sha256_matches_the_published_vectors() {
        assert_eq!(
            sha256(&b""[..]).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256(&b"abc"[..]).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_reads_past_its_buffer() {
        assert_eq!(
            sha256(&vec![b'a'; LONG_INPUT_BYTES][..]).unwrap(),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
