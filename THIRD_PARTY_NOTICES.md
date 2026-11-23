# Third-party notices

`dsh-code-reader` ships its own Python engine (standard library only) and a
DSH Host plugin (Node built-ins only). It does not redistribute third-party
runtime packages, parsers or databases.

## Redistributed source excerpts (presentation only)

- **UBS Engine**, commit `0f8a279278433914c9bd1d4f3a2c3a40572cc40a`,
  from `https://atomgit.com/openeuler/ubs-engine` — **MulanPSL-2.0**.
  `demo/code-view/control-plane-case.json` contains unmodified, line-numbered
  excerpts of NUMA ledger APIs, ledger templates and LoggingLockGuard for the
  reviewed source example. Original copyright headers, full upstream license,
  file hashes and provenance accompany the data and are embedded in the Demo
  and generated client bundle. The license is accessible under the example's
  “来源、范围与许可”. These excerpts are not built or executed. The rendering,
  summaries and relationship annotations are this project's presentation code;
  they are not upstream runtime or compiler analysis outputs.

## Referenced (not redistributed)

- **SDK Code Atlas 0.8.0 / schema 0.1** — MIT. Read only as a design/format
  reference from `H:/VSCODE_READER` (git commit
  `c33320a98face14c5f6e5e817beaccf52b9bbb93`). Its Python runtime, Clang
  resources, libclang, CMake/Ninja packages and analysis databases are **not**
  included in this repository. File hashes and license facts are recorded in
  [`source.lock.json`](source.lock.json).
- **DSH Harness Host API** — hosted plugin interfaces, not redistributed. The
  plugin targets the installed Host services (`ctx.tools`, `ctx.skills`,
  `ctx.effect`) discovered through `cordis_inspect_query`.
- **superpowers-dsh 0.4.0** — MIT, installed locally. Used only as a pattern
  reference for packaging a skill provider; no source file was copied.

If a future version vendors a fixed Python/Atlas runtime, its upstream license
files (PSF for CPython, MIT for Atlas, Apache-2.0-with-LLVM-exceptions for
libclang, LLVM headers license for Clang resource headers, plus CMake/Ninja
notices) must be added beside the vendored artifacts before distribution.
