use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::Arc,
};

use comic_platform_domain::{
    CreateGalleryTaskRequest, CreateRetryFolderTaskRequest, CreateSearchTaskRequest,
    SourceAdapterDescriptor, SourceCapability, SourceId,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::process::Command;

pub type AdapterResult<T> = Result<T, AdapterError>;
pub type AdapterFuture<'a, T> = Pin<Box<dyn Future<Output = AdapterResult<T>> + Send + 'a>>;

const DEFAULT_SOURCE_ID: &str = "fangliding";
const BUILTIN_SOURCE_ADAPTER_CONFIG: &str = include_str!("../../../config/source-adapters.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GallerySummary {
    pub source_id: SourceId,
    pub gallery_url: String,
    pub title: String,
    pub tags: Vec<String>,
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryMetadata {
    pub source_id: SourceId,
    pub gallery_url: String,
    pub title: String,
    pub tags: Vec<String>,
    pub page_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryDownloadReport {
    pub source_id: SourceId,
    pub gallery_url: String,
    pub title: String,
    pub output_folder: String,
    pub page_count: Option<u32>,
    pub done: u32,
    pub skipped: u32,
    pub failed: u32,
    pub stopped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageDescriptor {
    pub source_id: SourceId,
    pub gallery_url: String,
    pub page_url: String,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadedArtifact {
    pub source_id: SourceId,
    pub page_url: String,
    pub storage_key: String,
    pub content_type: Option<String>,
    pub byte_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPlan {
    pub source_id: SourceId,
    pub folder: String,
    pub page_indexes: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterErrorKind {
    UnknownSource,
    UnsupportedCapability,
    NotImplemented,
    InvalidInput,
    ExecutionFailed,
}

#[derive(Debug, Clone)]
pub struct AdapterError {
    pub kind: AdapterErrorKind,
    pub message: String,
}

impl AdapterError {
    pub fn unknown_source(source_id: &str) -> Self {
        Self {
            kind: AdapterErrorKind::UnknownSource,
            message: format!("unknown source adapter: {source_id}"),
        }
    }

    pub fn unsupported_capability(source_id: &str, capability: SourceCapability) -> Self {
        Self {
            kind: AdapterErrorKind::UnsupportedCapability,
            message: format!(
                "source adapter {source_id} does not support {}",
                capability.as_str()
            ),
        }
    }

    pub fn not_implemented(operation: &str) -> Self {
        Self {
            kind: AdapterErrorKind::NotImplemented,
            message: format!("source adapter operation is not implemented yet: {operation}"),
        }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            kind: AdapterErrorKind::InvalidInput,
            message: message.into(),
        }
    }

    pub fn execution_failed(message: impl Into<String>) -> Self {
        Self {
            kind: AdapterErrorKind::ExecutionFailed,
            message: message.into(),
        }
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AdapterError {}

pub trait SourceAdapter: Send + Sync {
    fn descriptor(&self) -> SourceAdapterDescriptor;

    fn search<'a>(
        &'a self,
        request: CreateSearchTaskRequest,
    ) -> AdapterFuture<'a, Vec<GallerySummary>>;

    fn read_gallery<'a>(
        &'a self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterFuture<'a, GalleryMetadata>;

    fn download_gallery<'a>(
        &'a self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterFuture<'a, GalleryDownloadReport>;

    fn list_pages<'a>(&'a self, gallery: GalleryMetadata)
    -> AdapterFuture<'a, Vec<PageDescriptor>>;

    fn download_page<'a>(&'a self, page: PageDescriptor) -> AdapterFuture<'a, DownloadedArtifact>;

    fn retry_folder<'a>(
        &'a self,
        request: CreateRetryFolderTaskRequest,
    ) -> AdapterFuture<'a, RetryPlan>;
}

#[derive(Clone)]
pub struct SourceAdapterRegistry {
    adapters: HashMap<SourceId, Arc<dyn SourceAdapter>>,
    default_source_id: SourceId,
}

impl Default for SourceAdapterRegistry {
    fn default() -> Self {
        Self::with_builtin_adapters()
    }
}

impl SourceAdapterRegistry {
    pub fn with_builtin_adapters() -> Self {
        let config =
            source_adapter_config().expect("built-in source adapter config should be valid JSON");
        let default_source_id = config.default_source_id.clone();
        let adapters = config.sources.into_iter().map(|config| {
            let adapter = PythonBridgeAdapter::from_config(config)
                .expect("built-in python bridge adapter config should be valid");
            Arc::new(adapter) as Arc<dyn SourceAdapter>
        });

        Self::with_default_source_id(default_source_id, adapters)
            .expect("built-in source adapters should be valid")
    }

    pub fn new(adapters: impl IntoIterator<Item = Arc<dyn SourceAdapter>>) -> AdapterResult<Self> {
        Self::with_default_source_id(DEFAULT_SOURCE_ID.to_string(), adapters)
    }

    pub fn with_default_source_id(
        default_source_id: SourceId,
        adapters: impl IntoIterator<Item = Arc<dyn SourceAdapter>>,
    ) -> AdapterResult<Self> {
        let mut registry = Self {
            adapters: HashMap::new(),
            default_source_id,
        };

        for adapter in adapters {
            registry.register(adapter)?;
        }

        if !registry.adapters.contains_key(&registry.default_source_id) {
            return Err(AdapterError::invalid_input(format!(
                "default source adapter is not registered: {}",
                registry.default_source_id
            )));
        }

        Ok(registry)
    }

    pub fn register(&mut self, adapter: Arc<dyn SourceAdapter>) -> AdapterResult<()> {
        let descriptor = adapter.descriptor();
        let id = descriptor.id.trim();
        if id.is_empty() {
            return Err(AdapterError::invalid_input("source adapter id is required"));
        }

        if self.adapters.contains_key(id) {
            return Err(AdapterError::invalid_input(format!(
                "duplicate source adapter id: {id}"
            )));
        }

        self.adapters.insert(id.to_string(), adapter);
        Ok(())
    }

    pub fn list(&self) -> Vec<SourceAdapterDescriptor> {
        let mut descriptors: Vec<_> = self
            .adapters
            .values()
            .map(|adapter| adapter.descriptor())
            .collect();
        descriptors.sort_by(|left, right| left.name.cmp(&right.name));
        descriptors
    }

    pub fn default_source_id(&self) -> &str {
        &self.default_source_id
    }

    pub fn resolve_source_id(&self, source_id: Option<&str>) -> String {
        source_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.default_source_id())
            .to_string()
    }

    pub fn resolve_source_ids(
        &self,
        source_id: Option<&str>,
        source_ids: &[SourceId],
    ) -> Vec<SourceId> {
        let requested = if source_ids.is_empty() {
            vec![self.resolve_source_id(source_id)]
        } else {
            source_ids.to_vec()
        };
        let mut seen = HashSet::new();
        requested
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && seen.insert(value.clone()))
            .collect()
    }

    pub fn require_capability(
        &self,
        source_id: &str,
        capability: SourceCapability,
    ) -> AdapterResult<SourceAdapterDescriptor> {
        let adapter = self
            .adapters
            .get(source_id)
            .ok_or_else(|| AdapterError::unknown_source(source_id))?;
        let descriptor = adapter.descriptor();

        if !descriptor.enabled {
            return Err(AdapterError::invalid_input(format!(
                "source adapter {source_id} is disabled"
            )));
        }
        if !descriptor.supports(&capability) {
            return Err(AdapterError::unsupported_capability(source_id, capability));
        }

        Ok(descriptor)
    }

    pub fn adapter(&self, source_id: &str) -> AdapterResult<Arc<dyn SourceAdapter>> {
        self.adapters
            .get(source_id)
            .cloned()
            .ok_or_else(|| AdapterError::unknown_source(source_id))
    }
}

#[derive(Clone, Debug, Deserialize)]
struct SourceAdapterConfig {
    default_source_id: SourceId,
    sources: Vec<PythonBridgeSourceConfig>,
}

#[derive(Clone, Debug, Deserialize)]
struct PythonBridgeSourceConfig {
    #[serde(flatten)]
    descriptor: SourceAdapterDescriptor,
    bridge: PythonBridgeConfig,
}

#[derive(Clone, Debug, Deserialize)]
struct PythonBridgeConfig {
    kind: String,
    script: String,
    script_env: Option<String>,
    #[serde(default)]
    python_env: Vec<String>,
    #[serde(default)]
    page_commands: bool,
}

fn source_adapter_config() -> AdapterResult<SourceAdapterConfig> {
    let json = match std::env::var("SOURCE_ADAPTER_CONFIG") {
        Ok(path) if !path.trim().is_empty() => std::fs::read_to_string(&path).map_err(|error| {
            AdapterError::execution_failed(format!(
                "failed to read source adapter config {path}: {error}"
            ))
        })?,
        _ => BUILTIN_SOURCE_ADAPTER_CONFIG.to_string(),
    };

    serde_json::from_str(&json).map_err(|error| {
        AdapterError::invalid_input(format!("failed to parse source adapter config: {error}"))
    })
}

#[derive(Clone)]
pub struct PythonBridgeAdapter {
    descriptor: SourceAdapterDescriptor,
    bridge: PythonBridge,
    page_commands: bool,
}

impl PythonBridgeAdapter {
    fn from_config(config: PythonBridgeSourceConfig) -> AdapterResult<Self> {
        if config.bridge.kind != "python" {
            return Err(AdapterError::invalid_input(format!(
                "unsupported source adapter bridge kind for {}: {}",
                config.descriptor.id, config.bridge.kind
            )));
        }

        let bridge = PythonBridge::from_config(&config);
        Ok(Self {
            page_commands: config.bridge.page_commands,
            descriptor: config.descriptor,
            bridge,
        })
    }
}

impl SourceAdapter for PythonBridgeAdapter {
    fn descriptor(&self) -> SourceAdapterDescriptor {
        self.descriptor.clone()
    }

    fn search<'a>(
        &'a self,
        request: CreateSearchTaskRequest,
    ) -> AdapterFuture<'a, Vec<GallerySummary>> {
        Box::pin(async move {
            let response = self.bridge.search(request).await?;
            Ok(response
                .results
                .into_iter()
                .map(|item| GallerySummary {
                    source_id: source_id_or_default(item.source_id, &self.descriptor.id),
                    gallery_url: item.url,
                    title: item.title,
                    tags: item.tags,
                    thumbnail_url: item.thumbnail_url,
                })
                .collect())
        })
    }

    fn read_gallery<'a>(
        &'a self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterFuture<'a, GalleryMetadata> {
        Box::pin(async move {
            let response = self.bridge.gallery(request).await?;
            Ok(GalleryMetadata {
                source_id: source_id_or_default(response.source_id, &self.descriptor.id),
                gallery_url: response.url,
                title: response.title,
                tags: response.tags,
                page_count: response.page_count,
            })
        })
    }

    fn download_gallery<'a>(
        &'a self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterFuture<'a, GalleryDownloadReport> {
        Box::pin(async move {
            let response = self.bridge.download_gallery(request).await?;
            Ok(GalleryDownloadReport {
                source_id: source_id_or_default(response.source_id, &self.descriptor.id),
                gallery_url: response.url,
                title: response.title,
                output_folder: response.output_folder,
                page_count: response.page_count,
                done: response.done,
                skipped: response.skipped,
                failed: response.failed,
                stopped: response.stopped,
            })
        })
    }

    fn list_pages<'a>(
        &'a self,
        gallery: GalleryMetadata,
    ) -> AdapterFuture<'a, Vec<PageDescriptor>> {
        Box::pin(async move {
            if !self.page_commands {
                return Err(AdapterError::not_implemented("list_pages"));
            }

            let response = self.bridge.list_pages(&gallery.gallery_url).await?;
            Ok(response
                .pages
                .into_iter()
                .map(|item| PageDescriptor {
                    source_id: source_id_or_default(item.source_id, &self.descriptor.id),
                    gallery_url: item.gallery_url,
                    page_url: item.page_url,
                    index: item.index,
                })
                .collect())
        })
    }

    fn download_page<'a>(&'a self, page: PageDescriptor) -> AdapterFuture<'a, DownloadedArtifact> {
        Box::pin(async move {
            if !self.page_commands {
                return Err(AdapterError::not_implemented("download_page"));
            }

            let response = self.bridge.download_page(page).await?;
            Ok(DownloadedArtifact {
                source_id: source_id_or_default(response.source_id, &self.descriptor.id),
                page_url: response.page_url,
                storage_key: response.storage_key,
                content_type: response.content_type,
                byte_size: response.byte_size,
            })
        })
    }

    fn retry_folder<'a>(
        &'a self,
        request: CreateRetryFolderTaskRequest,
    ) -> AdapterFuture<'a, RetryPlan> {
        Box::pin(async move {
            let response = self.bridge.retry_plan(request).await?;
            Ok(RetryPlan {
                source_id: source_id_or_default(response.source_id, &self.descriptor.id),
                folder: response.folder,
                page_indexes: response.page_indexes,
            })
        })
    }
}

#[derive(Clone)]
struct PythonBridge {
    label: String,
    python: String,
    script: PathBuf,
}

impl PythonBridge {
    fn from_config(config: &PythonBridgeSourceConfig) -> Self {
        let project_root = project_root();
        let legacy_python = legacy_python(&project_root);

        let python = config
            .bridge
            .python_env
            .iter()
            .find_map(|env_key| std::env::var(env_key).ok())
            .or(legacy_python)
            .unwrap_or_else(|| "python".to_string());

        let script = config
            .bridge
            .script_env
            .as_ref()
            .and_then(|env_key| std::env::var(env_key).ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| project_path(&project_root, &config.bridge.script));

        Self {
            label: config.descriptor.name.clone(),
            python,
            script,
        }
    }

    async fn search(&self, request: CreateSearchTaskRequest) -> AdapterResult<SearchBridgeOutput> {
        let tags_json = serde_json::to_string(&request.tags)
            .map_err(|error| AdapterError::invalid_input(error.to_string()))?;
        let mut args = vec![
            "search".to_string(),
            "--tags-json".to_string(),
            tags_json,
            "--limit".to_string(),
            request.limit.to_string(),
        ];

        if let Some(name) = request.name.filter(|value| !value.trim().is_empty()) {
            args.extend(["--name".to_string(), name]);
        }
        if let Some(query) = request.query.filter(|value| !value.trim().is_empty()) {
            args.extend(["--query".to_string(), query]);
        }

        self.run(args).await
    }

    async fn gallery(
        &self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterResult<GalleryBridgeOutput> {
        self.run(vec![
            "gallery".to_string(),
            "--gallery-url".to_string(),
            request.gallery_url,
        ])
        .await
    }

    async fn download_gallery(
        &self,
        request: CreateGalleryTaskRequest,
    ) -> AdapterResult<GalleryDownloadBridgeOutput> {
        self.run(vec![
            "download-gallery".to_string(),
            "--gallery-url".to_string(),
            request.gallery_url,
        ])
        .await
    }

    async fn list_pages(&self, gallery_url: &str) -> AdapterResult<PageListBridgeOutput> {
        self.run(vec![
            "list-pages".to_string(),
            "--gallery-url".to_string(),
            gallery_url.to_string(),
        ])
        .await
    }

    async fn download_page(&self, page: PageDescriptor) -> AdapterResult<DownloadPageBridgeOutput> {
        self.run(vec![
            "download-page".to_string(),
            "--gallery-url".to_string(),
            page.gallery_url,
            "--page-url".to_string(),
            page.page_url,
            "--page-index".to_string(),
            page.index.to_string(),
        ])
        .await
    }

    async fn retry_plan(
        &self,
        request: CreateRetryFolderTaskRequest,
    ) -> AdapterResult<RetryBridgeOutput> {
        let mut args = vec![
            "retry-plan".to_string(),
            "--folder".to_string(),
            request.folder,
        ];

        if request.missing_only {
            args.push("--missing-only".to_string());
        }
        if let Some(start_page) = request.start_page {
            args.extend(["--start-page".to_string(), start_page.to_string()]);
        }
        if let Some(end_page) = request.end_page {
            args.extend(["--end-page".to_string(), end_page.to_string()]);
        }

        self.run(args).await
    }

    async fn run<T>(&self, args: Vec<String>) -> AdapterResult<T>
    where
        T: DeserializeOwned,
    {
        let output = Command::new(&self.python)
            .arg(&self.script)
            .args(args)
            .output()
            .await
            .map_err(|error| {
                AdapterError::execution_failed(format!(
                    "failed to execute {} bridge {}: {error}",
                    self.label,
                    self.script.display()
                ))
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let message = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            return Err(AdapterError::execution_failed(format!(
                "{} bridge failed: {message}",
                self.label
            )));
        }

        serde_json::from_slice(&output.stdout).map_err(|error| {
            AdapterError::execution_failed(format!(
                "failed to parse {} bridge JSON: {error}",
                self.label
            ))
        })
    }
}

fn project_root() -> PathBuf {
    let package_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    package_root
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn project_path(project_root: &std::path::Path, path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        project_root.join(path)
    }
}

fn legacy_python(project_root: &std::path::Path) -> Option<String> {
    project_root
        .parent()
        .map(|parent| parent.join(".venv").join("Scripts").join("python.exe"))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}

fn source_id_or_default(source_id: Option<SourceId>, fallback: &str) -> SourceId {
    source_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

#[derive(Debug, Deserialize)]
struct SearchBridgeOutput {
    #[allow(dead_code)]
    query: String,
    results: Vec<SearchBridgeItem>,
}

#[derive(Debug, Deserialize)]
struct SearchBridgeItem {
    source_id: Option<SourceId>,
    title: String,
    url: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    thumbnail_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GalleryBridgeOutput {
    source_id: Option<SourceId>,
    title: String,
    url: String,
    tags: Vec<String>,
    page_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct GalleryDownloadBridgeOutput {
    source_id: Option<SourceId>,
    title: String,
    url: String,
    output_folder: String,
    page_count: Option<u32>,
    done: u32,
    skipped: u32,
    failed: u32,
    stopped: bool,
}

#[derive(Debug, Deserialize)]
struct PageListBridgeOutput {
    pages: Vec<PageBridgeItem>,
}

#[derive(Debug, Deserialize)]
struct PageBridgeItem {
    source_id: Option<SourceId>,
    gallery_url: String,
    page_url: String,
    index: u32,
}

#[derive(Debug, Deserialize)]
struct DownloadPageBridgeOutput {
    source_id: Option<SourceId>,
    page_url: String,
    storage_key: String,
    content_type: Option<String>,
    byte_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RetryBridgeOutput {
    source_id: Option<SourceId>,
    folder: String,
    page_indexes: Vec<u32>,
}
