param(
    [ValidateSet('web','api','api-offline','check','build','e2e','python','browser')]
    [string]$Task = 'web',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = $env:WSP_NODE_EXE
if (-not $taskNode) {
    $taskNodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $taskNodeCommand) { throw 'Install Node 24.22.0 on PATH or select it with WSP_NODE_EXE.' }
    $taskNode = $taskNodeCommand.Source
}
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) { throw 'WSP_NODE_EXE must identify an existing Node 24.22.0 executable.' }
$taskNode = (Resolve-Path -LiteralPath $taskNode).Path
$taskNodeVersion = & $taskNode --version
if ($LASTEXITCODE -ne 0 -or $taskNodeVersion -ne 'v24.22.0') { throw 'Use Node 24.22.0 on PATH or select it with WSP_NODE_EXE.' }
$taskOldPath = $env:PATH
$taskOldBrowsers = $env:PLAYWRIGHT_BROWSERS_PATH
$taskOldPythonPath = $env:PYTHONPATH
$taskOldCollectionEnabled = $env:WSP_COLLECTION_ENABLED
Push-Location $taskRoot
try {
    $env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $taskRoot '.cache\ms-playwright'
    $env:PYTHONPATH = Join-Path $taskRoot 'collectors\python'
    switch ($Task) {
        'web' { & $taskNode 'node_modules/vite/bin/vite.js' --config apps/web/vite.config.js }
        'api' {
            $env:WSP_COLLECTION_ENABLED = 'true'
            & $taskNode --env-file-if-exists=.env apps/api/server.js
        }
        'api-offline' {
            $env:WSP_COLLECTION_ENABLED = 'false'
            & $taskNode apps/api/server.js
        }
        'build' { & $taskNode 'node_modules/vite/bin/vite.js' build --config apps/web/vite.config.js }
        'e2e' { & $taskNode 'node_modules/@playwright/test/cli.js' test --config playwright.offline.config.js }
        'python' { & '.\.venv\Scripts\python.exe' -m web_scraper @Arguments }
        'browser' { & $taskNode --env-file-if-exists=.env tools/browser/pdf.js @Arguments }
        'check' {
            $taskChecks = @(
                @('node_modules/prettier/bin/prettier.cjs','--check','.'),
                @('node_modules/eslint/bin/eslint.js','.','--max-warnings','0'),
                @('node_modules/typescript/bin/tsc','--noEmit','-p','apps/api/tsconfig.json'),
                @('node_modules/typescript/bin/tsc','--noEmit','-p','apps/web/tsconfig.json'),
                @('node_modules/typescript/bin/tsc','--noEmit','-p','tools/browser/tsconfig.json'),
                @('--test','apps/api/test/*.test.js','tools/browser/*.test.js','tests/integration/*.test.js')
            )
            foreach ($taskCheck in $taskChecks) { & $taskNode @taskCheck; if ($LASTEXITCODE) { throw 'A required JavaScript check failed.' } }
            $taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
            $taskPythonChecks = @(
                @('-m','ruff','check','collectors/python'),
                @('-m','ruff','format','--check','collectors/python'),
                @('-m','mypy','--strict','--python-version','3.14','collectors/python/web_scraper'),
                @('-m','compileall','-q','collectors/python'),
                @('-m','pytest','-q'),
                @('-m','pip','check')
            )
            foreach ($taskCheck in $taskPythonChecks) { & $taskPython @taskCheck; if ($LASTEXITCODE) { throw 'A required Python check failed.' } }
        }
    }
    if ($LASTEXITCODE) { throw 'The selected command did not complete successfully.' }
} finally {
    Pop-Location
    $env:PATH = $taskOldPath
    $env:PLAYWRIGHT_BROWSERS_PATH = $taskOldBrowsers
    $env:PYTHONPATH = $taskOldPythonPath
    $env:WSP_COLLECTION_ENABLED = $taskOldCollectionEnabled
}
