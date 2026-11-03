// SPDX-License-Identifier: GPL-3.0-or-later
//! Reads the command line of this process, or of a second one that passed it on.
use std::path::Path;

const MEASURE: &str = "--measure";
const MEASURE_OPEN: &str = "--measure-open";
const MEASURE_T0: &str = "--t0";
const MEASURE_OUT: &str = "--measure-out";
const DUMP_TABS: &str = "--dump-tabs";
const SHOW_PANEL: &str = "--show-panel";
const SPEECH: &str = "--speech";
const SPEECH_TEST_VOLUME: &str = "--speech-test-volume";
const SPEECH_TEST_LOG: &str = "--speech-test-log";
const OPTION_MARK: &str = "--";

/// A run of `measure.ps1 -Warm`: what to open, when it was launched as a FILETIME, and where the time goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeasureOpen {
    pub path: String,
    pub t0: u64,
    pub out: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Launch {
    /// The files to open, always absolute.
    pub paths: Vec<String>,
    pub measure: bool,
    pub measure_open: Option<MeasureOpen>,
    pub dump_tabs: Option<String>,
    pub show_panel: Option<String>,
    /// Only the smoke build listens: what to do to the reading, as a key would.
    pub speech: Option<String>,
    /// Only the smoke build listens: how loud a test run speaks.
    pub speech_test_volume: Option<String>,
    /// Only the smoke build listens: where a test run logs its sentences.
    pub speech_test_log: Option<String>,
}

impl Launch {
    /// `args` leaves out the program name.
    pub fn parse(args: impl IntoIterator<Item = String>, cwd: &Path) -> Self {
        let mut launch = Self::default();
        let (mut open_path, mut open_t0, mut open_out) = (None, None, None);
        let absolute = |path: String| cwd.join(path).to_string_lossy().into_owned();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                MEASURE => {
                    launch.measure = true;
                    launch.paths.extend(args.next().map(absolute));
                }
                MEASURE_OPEN => open_path = args.next().map(absolute),
                MEASURE_T0 => open_t0 = args.next().and_then(|t0| t0.parse().ok()),
                MEASURE_OUT => open_out = args.next(),
                DUMP_TABS => launch.dump_tabs = args.next(),
                SHOW_PANEL => launch.show_panel = args.next(),
                SPEECH => launch.speech = args.next(),
                SPEECH_TEST_VOLUME => launch.speech_test_volume = args.next(),
                SPEECH_TEST_LOG => launch.speech_test_log = args.next(),
                option if option.starts_with(OPTION_MARK) => {}
                _ => launch.paths.push(absolute(arg)),
            }
        }
        if let (Some(path), Some(t0), Some(out)) = (open_path, open_t0, open_out) {
            launch.measure_open = Some(MeasureOpen { path, t0, out });
        }
        launch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Launch {
        Launch::parse(args.iter().map(|arg| arg.to_string()), Path::new("C:\\cwd"))
    }

    #[test]
    fn plain_arguments_are_the_files_to_open() {
        let launch = parse(&["C:\\x\\a b, è.md", "C:\\x\\b.epub"]);
        assert_eq!(launch.paths, ["C:\\x\\a b, è.md", "C:\\x\\b.epub"]);
        assert!(!launch.measure);
    }

    #[test]
    fn a_relative_file_starts_from_the_folder_of_the_process() {
        assert_eq!(parse(&["sub\\a.md"]).paths, ["C:\\cwd\\sub\\a.md"]);
    }

    #[test]
    fn no_arguments_mean_no_files() {
        assert_eq!(parse(&[]), Launch::default());
    }

    #[test]
    fn measure_opens_its_file_and_marks_the_run() {
        let launch = parse(&["--measure", "C:\\x\\a.md"]);
        assert_eq!(launch.paths, ["C:\\x\\a.md"]);
        assert!(launch.measure);
    }

    #[test]
    fn measure_open_keeps_its_file_apart_from_the_tabs_to_open() {
        let launch = parse(&[
            "--measure-open",
            "C:\\x\\a.md",
            "--t0",
            "133",
            "--measure-out",
            "C:\\r.txt",
        ]);
        assert!(launch.paths.is_empty());
        assert_eq!(
            launch.measure_open,
            Some(MeasureOpen {
                path: "C:\\x\\a.md".to_string(),
                t0: 133,
                out: "C:\\r.txt".to_string(),
            })
        );
    }

    #[test]
    fn measure_open_without_its_values_is_ignored() {
        assert_eq!(parse(&["--measure-open", "C:\\x\\a.md"]).measure_open, None);
        let bad_clock = parse(&[
            "--measure-open",
            "C:\\x\\a.md",
            "--t0",
            "no",
            "--measure-out",
            "r",
        ]);
        assert_eq!(bad_clock.measure_open, None);
    }

    #[test]
    fn dump_tabs_takes_its_file() {
        let launch = parse(&["--dump-tabs", "C:\\d.json"]);
        assert!(launch.paths.is_empty());
        assert_eq!(launch.dump_tabs.as_deref(), Some("C:\\d.json"));
    }

    #[test]
    fn show_panel_takes_its_name() {
        let launch = parse(&["--show-panel", "licenses"]);
        assert!(launch.paths.is_empty());
        assert_eq!(launch.show_panel.as_deref(), Some("licenses"));
    }

    #[test]
    fn speech_takes_the_command_to_run() {
        let launch = parse(&["--speech", "speech.start"]);
        assert!(launch.paths.is_empty());
        assert_eq!(launch.speech.as_deref(), Some("speech.start"));
    }

    #[test]
    fn the_test_settings_of_speech_take_their_values() {
        let launch = parse(&[
            "--speech-test-volume",
            "0.05",
            "--speech-test-log",
            "C:\\l.jsonl",
        ]);
        assert!(launch.paths.is_empty());
        assert_eq!(launch.speech_test_volume.as_deref(), Some("0.05"));
        assert_eq!(launch.speech_test_log.as_deref(), Some("C:\\l.jsonl"));
    }

    #[test]
    fn unknown_options_are_not_files() {
        assert!(parse(&["--whatever"]).paths.is_empty());
    }
}
