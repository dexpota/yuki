import { readFile, writeFile } from 'node:fs/promises';

const imageNames = ['backend', 'web', 'processor'];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const revisionPattern = /^[a-f0-9]{40}$/;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePlatforms(index, imageName) {
  if (!Array.isArray(index.manifests))
    throw new Error(`${imageName} is not a multi-platform index.`);

  const platforms = index.manifests
    .filter(
      ({ platform }) =>
        platform?.os === 'linux' && ['amd64', 'arm64'].includes(platform.architecture),
    )
    .map(({ digest, platform }) => {
      if (!digestPattern.test(digest))
        throw new Error(`${imageName} has an invalid platform digest.`);
      return { os: platform.os, architecture: platform.architecture, digest };
    })
    .sort((left, right) => left.architecture.localeCompare(right.architecture));

  const actual = platforms.map(({ architecture }) => architecture).join(',');
  if (actual !== 'amd64,arm64') {
    throw new Error(`${imageName} platforms are '${actual}', expected 'amd64,arm64'.`);
  }
  return platforms;
}

async function imageDescriptor(name) {
  const prefix = `YUKI_${name.toUpperCase()}`;
  const tag = required(`${prefix}_TAG`);
  const reference = required(`${prefix}_REFERENCE`);
  const digest = reference.slice(reference.lastIndexOf('@') + 1);
  if (!digestPattern.test(digest)) throw new Error(`${name} has an invalid index digest.`);
  const index = JSON.parse(await readFile(required(`${prefix}_INDEX_FILE`), 'utf8'));
  return { tag, reference, digest, platforms: parsePlatforms(index, name) };
}

const version = required('YUKI_RELEASE_VERSION');
const tag = required('YUKI_RELEASE_TAG');
const sourceRevision = required('YUKI_SOURCE_REVISION');
const sourceRepository = required('YUKI_SOURCE_REPOSITORY');
const createdAt = required('YUKI_RELEASE_CREATED_AT');
if (!versionPattern.test(version) || tag !== `v${version}`)
  throw new Error('Release tag must be exact vMAJOR.MINOR.PATCH SemVer.');
if (!revisionPattern.test(sourceRevision))
  throw new Error('Source revision must be a full lowercase Git SHA.');
if (Number.isNaN(Date.parse(createdAt))) throw new Error('Release creation time must be ISO-8601.');

const images = {};
for (const name of imageNames) images[name] = await imageDescriptor(name);

const manifest = {
  schemaVersion: 1,
  release: { version, tag, sourceRevision, sourceRepository, createdAt },
  images,
};
await writeFile(required('YUKI_RELEASE_IMAGES_OUTPUT'), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: 'wx',
});
