// SPDX-License-Identifier: GPL-3.0-or-later
//! Clocks for the startup measures.
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

const FILETIME_TICKS_PER_MS: f64 = 10_000.0;
const UNIX_EPOCH_AS_FILETIME: u64 = 116_444_736_000_000_000;
const HIGH_PART_SHIFT: u32 = 32;

fn ticks(time: FILETIME) -> u64 {
    u64::from(time.dwHighDateTime) << HIGH_PART_SHIFT | u64::from(time.dwLowDateTime)
}

pub fn now_filetime() -> u64 {
    ticks(unsafe { GetSystemTimePreciseAsFileTime() })
}

pub fn filetime_to_unix_ms(filetime: u64) -> f64 {
    filetime.saturating_sub(UNIX_EPOCH_AS_FILETIME) as f64 / FILETIME_TICKS_PER_MS
}

pub fn now_unix_ms() -> f64 {
    filetime_to_unix_ms(now_filetime())
}

/// When Windows created this process. The time to the first frame counts from here.
pub fn process_created_unix_ms() -> f64 {
    let (mut created, mut exited, mut kernel, mut user) = Default::default();
    let answered = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    match answered {
        Ok(()) => filetime_to_unix_ms(ticks(created)),
        Err(_) => now_unix_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS_PER_HOUR: f64 = 3_600_000.0;

    #[test]
    fn the_process_started_before_now() {
        let age = now_unix_ms() - process_created_unix_ms();
        assert!(age > 0.0 && age < MS_PER_HOUR, "{age}");
    }

    #[test]
    fn filetime_and_unix_clocks_agree() {
        let difference = (filetime_to_unix_ms(now_filetime()) - now_unix_ms()).abs();
        assert!(difference < MS_PER_HOUR, "{difference}");
    }
}
