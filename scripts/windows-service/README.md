# Windows service wrapper

Runs Pip as a native Windows service so he starts on boot, survives logout,
and auto-restarts if he crashes. Built on [NSSM](https://nssm.cc).

## One-time prerequisites

1. **Install NSSM.** Download `nssm.exe` from <https://nssm.cc/download>
   (use the 64-bit build) and drop it somewhere on your PATH, e.g.
   `A:\Claude\nssm.exe` or `C:\Windows\System32\nssm.exe`. The install script
   checks: `$env:NSSM`, PATH, `A:\Claude\nssm.exe`, Chocolatey's `bin`.
2. **Populate `.env`** in the repo root with Discord token, DB creds, etc.
   (It's gitignored; NSSM reads it via `dotenv` at runtime from `AppDirectory`.)
3. **Build once:** `npm install && npm run build`.

## Install / update

```powershell
npm run service:install
```

The script self-elevates (UAC prompt). It installs the service with:

- **Start type:** Automatic (boots with Windows, before login)
- **Restart on exit:** yes, with a 5s delay (prevents crash-loop thrash)
- **Logs:** `logs/stdout.log` + `logs/stderr.log`, rotated at 10 MB while the service runs (online rotation)

Re-running the script reconfigures and restarts an existing service, so it's
safe to run after every deploy.

## Uninstall

```powershell
npm run service:uninstall
```

## Operate

Day-to-day you don't need NSSM. Windows' own tools work:

```powershell
# Live-tail logs (stdout; use service:logs:err for the crash/error log)
npm run service:logs
npm run service:logs:err

# Restart / stop / start (needs admin shell)
Restart-Service ForgeRealmPip
Stop-Service    ForgeRealmPip
Start-Service   ForgeRealmPip

# Or: services.msc → find "ForgeRealm Pip Bot"
```

`nssm edit ForgeRealmPip` opens a GUI if you need to change paths / env vars
without reinstalling.

## After code changes

```powershell
npm run build
Restart-Service ForgeRealmPip
```

Or just `npm run service:install` again; it reconfigures and restarts.
