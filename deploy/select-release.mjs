import { readFile, writeFile } from 'node:fs/promises';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
  process.stderr.write('Usage: node deploy/select-release.mjs release-images.json OUTPUT.env\n');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const digest = /^sha256:[a-f0-9]{64}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const revision = /^[a-f0-9]{40}$/;
const roles = ['backend', 'web', 'processor', 'supervisor'];
if (
  manifest.schemaVersion !== 2 ||
  !version.test(manifest.release?.version) ||
  manifest.release.tag !== manifest.release.version ||
  !revision.test(manifest.release?.sourceRevision) ||
  Object.keys(manifest.images ?? {})
    .sort()
    .join(',') !== [...roles].sort().join(',')
)
  throw new Error('Expected a complete Yuki release-images.json v2 manifest.');

const lines = [
  `YUKI_RELEASE_VERSION=${manifest.release.version}`,
  `YUKI_RELEASE_REVISION=${manifest.release.sourceRevision}`,
];
for (const role of roles) {
  const image = manifest.images[role];
  const repository = `ghcr.io/dexpota/yuki-${role}`;
  if (
    !digest.test(image?.digest) ||
    image.reference !== `${repository}@${image.digest}` ||
    image.tag !== `${repository}:${manifest.release.version}` ||
    !Array.isArray(image.platforms) ||
    image.platforms.length !== 2 ||
    image.platforms
      .map((platform) => `${platform.os}/${platform.architecture}`)
      .sort()
      .join(',') !== 'linux/amd64,linux/arm64' ||
    image.platforms.some((platform) => !digest.test(platform.digest))
  )
    throw new Error(`Invalid ${role} image in release manifest.`);
  lines.push(`YUKI_${role.toUpperCase()}_IMAGE=${image.reference}`);
}

await writeFile(outputPath, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`Selected Yuki ${manifest.release.version}.\n`);
