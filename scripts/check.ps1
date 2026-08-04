$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

.\scripts\dev-env.ps1

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE"
  }
}

Write-Host "`n[check] JSON config"
Invoke-Checked { node -e "const fs=require('fs'); for (const f of ['package.json','apps/web/package.json','apps/web/tsconfig.json','config/source-adapters.json']) { JSON.parse(fs.readFileSync(f,'utf8')); console.log('ok', f); }" }

Write-Host "`n[check] Source adapter config"
Invoke-Checked { python .\scripts\check_source_adapters.py }

Write-Host "`n[check] Reverse proxy configuration"
Invoke-Checked { node .\scripts\check_reverse_proxy_config.mjs }

Write-Host "`n[check] Public access lifecycle"
Invoke-Checked { & .\scripts\check_public_access.ps1 }

Write-Host "`n[check] Public repository privacy"
Invoke-Checked { python .\scripts\check_public_repo.py }

Write-Host "`n[check] Dev API shim syntax"
Invoke-Checked { node --check .\services\dev-api\server.mjs }
Invoke-Checked { node --check .\services\dev-api\source-registry.mjs }
Invoke-Checked { node --check .\services\dev-api\source-auth.mjs }
Invoke-Checked { node --check .\services\dev-api\search-filter.mjs }
Invoke-Checked { node --check .\services\dev-api\async-pool.mjs }
Invoke-Checked { node --check .\services\dev-api\search-pipeline.mjs }
Invoke-Checked { node --check .\services\dev-api\search-results.mjs }
Invoke-Checked { node --check .\services\dev-api\download-quota.mjs }
Invoke-Checked { node --check .\services\dev-api\bridge-protocol.mjs }
Invoke-Checked { node --check .\services\dev-api\diagnostics.mjs }
Invoke-Checked { node --check .\services\dev-api\state-store.mjs }
Invoke-Checked { node --check .\services\dev-api\library-index.mjs }
Invoke-Checked { node --check .\services\dev-api\thumbnail-policy.mjs }

Write-Host "`n[check] Tag dictionary and exclusion rules"
Invoke-Checked { node .\scripts\check_tag_system.mjs }
Invoke-Checked { node .\scripts\check_search_pipeline.mjs }
Invoke-Checked { node .\scripts\check_search_results.mjs }
Invoke-Checked { node .\scripts\check_download_quota.mjs }
Invoke-Checked { node .\scripts\check_bridge_protocol.mjs }
Invoke-Checked { node .\scripts\check_source_auth.mjs }
Invoke-Checked { node .\scripts\check_diagnostics.mjs }
Invoke-Checked { node .\scripts\check_dev_api_search_merge.mjs }
Invoke-Checked { node .\scripts\check_async_pool.mjs }
Invoke-Checked { node .\scripts\check_state_store.mjs }
Invoke-Checked { node .\scripts\check_reader_progress.mjs }
Invoke-Checked { node .\scripts\check_reader_first_page.mjs }
Invoke-Checked { node .\scripts\check_reader_variants.mjs }
Invoke-Checked { node .\scripts\check_reader_cache_governance.mjs }
Invoke-Checked { node .\scripts\check_reader_list_expansion.mjs }
Invoke-Checked { node .\scripts\check_reader_album_prefetch.mjs }
Invoke-Checked { node .\scripts\check_library_index.mjs }
Invoke-Checked { node .\scripts\check_performance_baseline.mjs }
Invoke-Checked { node .\scripts\check_thumbnail_policy.mjs }
Invoke-Checked { python -m py_compile .\scripts\update_tag_translations.py .\scripts\sample_18comic_tags.py .\scripts\sync_source_tag_mappings.py .\scripts\audit_tag_alignment.py .\scripts\source_tag_resolver.py }
Invoke-Checked { python .\scripts\audit_tag_alignment.py --minimum-coverage 0.90 }

Write-Host "`n[check] Python bridges"
Invoke-Checked { python -c "import jmcomic; print('ok jmcomic', jmcomic.__version__ if hasattr(jmcomic, '__version__') else 'installed')" }
Invoke-Checked { python -m py_compile .\scripts\contract_validator.py .\scripts\source_bridge_core.py .\scripts\search_result_metadata.py .\scripts\gallery_search_parser.py .\scripts\source_tag_resolver.py .\scripts\jmcomic_api_adapter.py .\scripts\fangliding_bridge.py .\scripts\check_fangliding_pagination.py .\scripts\check_fangliding_reader.py .\scripts\check_gallery_search_parser.py .\scripts\run_source_adapter_self_tests.py .\scripts\18comic_bridge.py .\scripts\ehentai_bridge.py .\scripts\make_image_variants.py }
Invoke-Checked { python .\scripts\check_download_core.py }


Invoke-Checked { python .\scripts\check_gallery_search_parser.py }
Invoke-Checked { python .\scripts\run_source_adapter_self_tests.py }



Write-Host "`n[check] Rust format"
Invoke-Checked { & (Join-Path $env:CARGO_HOME "bin\cargo.exe") fmt --all -- --check }

Write-Host "`n[check] Rust workspace"
Invoke-Checked { & (Join-Path $env:CARGO_HOME "bin\cargo.exe") check --workspace --all-targets --all-features }

Write-Host "`n[check] Cross-runtime contracts"
Invoke-Checked { & (Join-Path $env:CARGO_HOME "bin\cargo.exe") run --quiet --no-default-features -p comic-platform-domain --bin contract_tool -- check-schema .\config\contracts\task.schema.json }
Invoke-Checked { & (Join-Path $env:CARGO_HOME "bin\cargo.exe") run --quiet --no-default-features -p comic-platform-domain --bin contract_tool -- check-bridge-error-schema .\config\contracts\bridge-error.schema.json }
Invoke-Checked { node .\scripts\check_contracts.mjs }

Write-Host "`n[check] Web unit tests"
Invoke-Checked { npm --prefix .\apps\web run test }

Write-Host "`n[check] Web build"
Invoke-Checked { npm --prefix .\apps\web run build }

Write-Host "`nAll checks passed."
Write-Host "`n[hint] This script only checks the project; it does not keep the app running."
Write-Host "[hint] To start the web version, run:"
Write-Host "       cd $ProjectRoot"
Write-Host "       .\scripts\dev.ps1"
Write-Host "[hint] If 3000/8080 is already used by this project, dev.ps1 will reuse it."
Write-Host "[hint] To force-restart the local services and load the newest code, run:"
Write-Host "       .\scripts\dev.ps1 -Fresh"
Write-Host "[hint] Then open http://127.0.0.1:3000 and keep that terminal open."
