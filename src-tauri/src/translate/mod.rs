// SPDX-License-Identifier: GPL-3.0-or-later
//! Translation of books with the models of Firefox Translations. The engine runs in the page; here the models are
//! downloaded, checked and handed to it.

pub mod catalog;
pub mod models;

use crate::tts::TtsError;
use std::sync::Arc;

async fn off_the_workers<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, TtsError> + Send + 'static,
) -> Result<T, TtsError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| TtsError::Engine(error.to_string()))?
}

/// The pairs the app offers, and which are installed. Reads the disk only.
#[tauri::command]
pub async fn tr_catalog(
    models: tauri::State<'_, Arc<models::Models>>,
) -> Result<models::CatalogView, TtsError> {
    let models = Arc::clone(&models);
    off_the_workers(move || Ok(models.view())).await
}

#[tauri::command]
pub async fn tr_download(
    pair: String,
    models: tauri::State<'_, Arc<models::Models>>,
) -> Result<(), TtsError> {
    let models = Arc::clone(&models);
    off_the_workers(move || models.download(&pair)).await
}

#[tauri::command]
pub async fn tr_cancel(
    pair: String,
    models: tauri::State<'_, Arc<models::Models>>,
) -> Result<(), TtsError> {
    models.cancel(&pair);
    Ok(())
}

#[tauri::command]
pub async fn tr_delete(
    pair: String,
    models: tauri::State<'_, Arc<models::Models>>,
) -> Result<(), TtsError> {
    let models = Arc::clone(&models);
    off_the_workers(move || models.delete(&pair)).await
}

/// One file of an installed pair, as raw bytes for the engine.
#[tauri::command]
pub async fn tr_model_file(
    pair: String,
    kind: String,
    models: tauri::State<'_, Arc<models::Models>>,
) -> Result<tauri::ipc::Response, TtsError> {
    let models = Arc::clone(&models);
    let bytes = off_the_workers(move || models.model_file(&pair, &kind)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
