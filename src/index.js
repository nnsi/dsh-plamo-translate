import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export const Config = z.object({
  autoStart: z.boolean().default(true),
  runtimeDirectory: z.string().default('.runtime'),
  port: z.natural().min(1).max(65535).default(18080),
});

/** Reuse or start the optional Windows-local API when the bundle loads. */
export async function apply(ctx, config) {
  if (!config.autoStart) return;
  if (process.platform !== 'win32') {
    throw new Error('Managed startup requires Windows. Set plamo-translation-api.autoStart=false to use an existing PLaMo API.');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  const powershell = join(process.env.SystemRoot ?? process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execute(powershell, [
    '-NoLogo', '-NoProfile', '-File', join(root, 'scripts', 'Start-PlamoTranslation.ps1'),
    '-RuntimeDirectory', resolve(root, config.runtimeDirectory), '-Port', String(config.port),
  ], { windowsHide: true, timeout: 75000, env, encoding: 'utf8' });
  ctx.logger.info('PLaMo translation API ready on loopback port %s', config.port);
}
