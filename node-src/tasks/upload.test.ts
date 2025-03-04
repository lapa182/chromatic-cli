import { createReadStream, readdirSync, readFileSync, statSync } from 'fs';
import progressStream from 'progress-stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { default as compress } from '../lib/compress';
import { getDependentStoryFiles as getDepStoryFiles } from '../lib/getDependentStoryFiles';
import { findChangedDependencies as findChangedDep } from '../lib/findChangedDependencies';
import { findChangedPackageFiles as findChangedPkg } from '../lib/findChangedPackageFiles';
import { validateFiles, traceChangedFiles, uploadStorybook } from './upload';

vi.mock('fs');
vi.mock('progress-stream');
vi.mock('../lib/compress');
vi.mock('../lib/getDependentStoryFiles');
vi.mock('../lib/findChangedDependencies');
vi.mock('../lib/findChangedPackageFiles');
vi.mock('./read-stats-file');

const makeZipFile = vi.mocked(compress);
const findChangedDependencies = vi.mocked(findChangedDep);
const findChangedPackageFiles = vi.mocked(findChangedPkg);
const getDependentStoryFiles = vi.mocked(getDepStoryFiles);
const createReadStreamMock = vi.mocked(createReadStream);
const readdirSyncMock = vi.mocked(readdirSync);
const readFileSyncMock = vi.mocked(readFileSync);
const statSyncMock = vi.mocked(statSync);
const progress = vi.mocked(progressStream);

const env = { CHROMATIC_RETRIES: 2, CHROMATIC_OUTPUT_INTERVAL: 0 };
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const http = { fetch: vi.fn() };

describe('validateFiles', () => {
  it('sets fileInfo on context', async () => {
    readdirSyncMock.mockReturnValue(['iframe.html', 'index.html'] as any);
    statSyncMock.mockReturnValue({ isDirectory: () => false, size: 42 } as any);

    const ctx = { env, log, http, sourceDir: '/static/' } as any;
    await validateFiles(ctx);

    expect(ctx.fileInfo).toEqual(
      expect.objectContaining({
        lengths: [
          { contentLength: 42, knownAs: 'iframe.html', pathname: 'iframe.html' },
          { contentLength: 42, knownAs: 'index.html', pathname: 'index.html' },
        ],
        paths: ['iframe.html', 'index.html'],
        total: 84,
      })
    );
  });

  it("throws when index.html doesn't exist", async () => {
    readdirSyncMock.mockReturnValue(['iframe.html'] as any);
    statSyncMock.mockReturnValue({ isDirectory: () => false, size: 42 } as any);

    const ctx = { env, log, http, sourceDir: '/static/' } as any;
    await expect(validateFiles(ctx)).rejects.toThrow('Invalid Storybook build at /static/');
  });

  it("throws when iframe.html doesn't exist", async () => {
    readdirSyncMock.mockReturnValue(['index.html'] as any);
    statSyncMock.mockReturnValue({ isDirectory: () => false, size: 42 } as any);

    const ctx = { env, log, http, sourceDir: '/static/' } as any;
    await expect(validateFiles(ctx)).rejects.toThrow('Invalid Storybook build at /static/');
  });

  describe('with buildLogFile', () => {
    it('retries using outputDir from build-storybook.log', async () => {
      readdirSyncMock.mockReturnValueOnce([]);
      readdirSyncMock.mockReturnValueOnce(['iframe.html', 'index.html'] as any);
      statSyncMock.mockReturnValue({ isDirectory: () => false, size: 42 } as any);
      readFileSyncMock.mockReturnValue('info => Output directory: /var/storybook-static');

      const ctx = {
        env,
        log,
        http,
        sourceDir: '/static/',
        buildLogFile: 'build-storybook.log',
        options: {},
        packageJson: {},
      } as any;
      await validateFiles(ctx);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Unexpected build directory'));
      expect(ctx.sourceDir).toBe('/var/storybook-static');
      expect(ctx.fileInfo).toEqual(
        expect.objectContaining({
          lengths: [
            { contentLength: 42, knownAs: 'iframe.html', pathname: 'iframe.html' },
            { contentLength: 42, knownAs: 'index.html', pathname: 'index.html' },
          ],
          paths: ['iframe.html', 'index.html'],
          total: 84,
        })
      );
    });
  });
});

describe('traceChangedFiles', () => {
  beforeEach(() => {
    findChangedDependencies.mockReset();
    findChangedPackageFiles.mockReset();
    getDependentStoryFiles.mockReset();
  });

  it('sets onlyStoryFiles on context', async () => {
    const deps = { 123: ['./example.stories.js'] };
    findChangedDependencies.mockResolvedValue([]);
    findChangedPackageFiles.mockResolvedValue([]);
    getDependentStoryFiles.mockResolvedValue(deps);

    const ctx = {
      env,
      log,
      http,
      options: {},
      sourceDir: '/static/',
      fileInfo: { statsPath: '/static/preview-stats.json' },
      git: { changedFiles: ['./example.js'] },
      turboSnap: {},
    } as any;
    await traceChangedFiles(ctx, {} as any);

    expect(ctx.onlyStoryFiles).toStrictEqual(Object.keys(deps));
  });

  it('ignores package.json changes if lockfile does not have changes', async () => {
    const deps = { 123: ['./example.stories.js'] };
    findChangedDependencies.mockResolvedValue([]);
    findChangedPackageFiles.mockResolvedValue(['./package.json']);
    getDependentStoryFiles.mockResolvedValue(deps);

    const ctx = {
      env,
      log,
      http,
      options: {},
      sourceDir: '/static/',
      fileInfo: { statsPath: '/static/preview-stats.json' },
      git: { changedFiles: ['./example.js'] },
      turboSnap: {},
    } as any;
    await traceChangedFiles(ctx, {} as any);

    expect(ctx.onlyStoryFiles).toStrictEqual(Object.keys(deps));
  });

  it('bails on package.json changes if it fails to retrieve lockfile changes (fallback scenario)', async () => {
    findChangedDependencies.mockRejectedValue(new Error('no lockfile'));
    findChangedPackageFiles.mockResolvedValue(['./package.json']);

    const packageManifestChanges = [{ changedFiles: ['./package.json'], commit: 'abcdef' }];
    const ctx = {
      env,
      log,
      http,
      options: {},
      sourceDir: '/static/',
      fileInfo: { statsPath: '/static/preview-stats.json' },
      git: { changedFiles: ['./example.js', './package.json'], packageManifestChanges },
      turboSnap: {},
    } as any;
    await traceChangedFiles(ctx, {} as any);

    expect(ctx.turboSnap.bailReason).toEqual({ changedPackageFiles: ['./package.json'] });
    expect(findChangedPackageFiles).toHaveBeenCalledWith(packageManifestChanges);
    expect(getDependentStoryFiles).not.toHaveBeenCalled();
  });

  it('continues story file tracing if no dependencies are changed in package.json (fallback scenario)', async () => {
    const deps = { 123: ['./example.stories.js'] };
    findChangedDependencies.mockRejectedValue(new Error('no lockfile'));
    findChangedPackageFiles.mockResolvedValue([]); // no dependency changes
    getDependentStoryFiles.mockResolvedValue(deps);

    const packageManifestChanges = [{ changedFiles: ['./package.json'], commit: 'abcdef' }];
    const ctx = {
      env,
      log,
      http,
      options: {},
      sourceDir: '/static/',
      fileInfo: { statsPath: '/static/preview-stats.json' },
      git: { changedFiles: ['./example.js', './package.json'], packageManifestChanges },
      turboSnap: {},
    } as any;
    await traceChangedFiles(ctx, {} as any);

    expect(ctx.turboSnap.bailReason).toBeUndefined();
    expect(ctx.onlyStoryFiles).toStrictEqual(Object.keys(deps));
    expect(findChangedPackageFiles).toHaveBeenCalledWith(packageManifestChanges);
  });

  it('ignores dependency changes in untraced package.json files (fallback scenario)', async () => {
    const deps = { 123: ['./example.stories.js'] };
    findChangedDependencies.mockRejectedValue(new Error('no lockfile'));
    findChangedPackageFiles.mockResolvedValue([]);
    getDependentStoryFiles.mockResolvedValue(deps);

    const packageManifestChanges = [{ changedFiles: ['./package.json'], commit: 'abcdef' }];
    const ctx = {
      env,
      log,
      http,
      options: { untraced: ['package.json'] },
      sourceDir: '/static/',
      fileInfo: { statsPath: '/static/preview-stats.json' },
      git: { changedFiles: ['./example.js', './package.json'], packageManifestChanges },
      turboSnap: {},
    } as any;
    await traceChangedFiles(ctx, {} as any);

    expect(ctx.onlyStoryFiles).toStrictEqual(Object.keys(deps));
    expect(findChangedPackageFiles).toHaveBeenCalledWith([]);
  });
});

describe('uploadStorybook', () => {
  it('retrieves the upload locations, puts the files there and sets the isolatorUrl on context', async () => {
    const client = { runQuery: vi.fn() };
    client.runQuery.mockReturnValue({
      getUploadUrls: {
        domain: 'https://asdqwe.chromatic.com',
        urls: [
          {
            path: 'iframe.html',
            url: 'https://asdqwe.chromatic.com/iframe.html',
            contentType: 'text/html',
          },
          {
            path: 'index.html',
            url: 'https://asdqwe.chromatic.com/index.html',
            contentType: 'text/html',
          },
        ],
      },
    });

    createReadStreamMock.mockReturnValue({ pipe: vi.fn() } as any);
    http.fetch.mockReturnValue({ ok: true });
    progress.mockReturnValue({ on: vi.fn() } as any);

    const fileInfo = {
      lengths: [
        { knownAs: 'iframe.html', contentLength: 42 },
        { knownAs: 'index.html', contentLength: 42 },
      ],
      paths: ['iframe.html', 'index.html'],
      total: 84,
    };
    const ctx = {
      client,
      env,
      log,
      http,
      sourceDir: '/static/',
      options: {},
      fileInfo,
      announcedBuild: { id: '1' },
    } as any;
    await uploadStorybook(ctx, {} as any);

    expect(client.runQuery).toHaveBeenCalledWith(expect.stringMatching(/GetUploadUrlsMutation/), {
      buildId: '1',
      paths: ['iframe.html', 'index.html'],
    });
    expect(http.fetch).toHaveBeenCalledWith(
      'https://asdqwe.chromatic.com/iframe.html',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'content-type': 'text/html',
          'content-length': '42',
          'cache-control': 'max-age=31536000',
        },
      }),
      expect.objectContaining({ retries: 0 })
    );
    expect(http.fetch).toHaveBeenCalledWith(
      'https://asdqwe.chromatic.com/index.html',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'content-type': 'text/html',
          'content-length': '42',
          'cache-control': 'max-age=31536000',
        },
      }),
      expect.objectContaining({ retries: 0 })
    );
    expect(ctx.uploadedBytes).toBe(84);
    expect(ctx.isolatorUrl).toBe('https://asdqwe.chromatic.com/iframe.html');
  });

  it('calls experimental_onTaskProgress with progress', async () => {
    const client = { runQuery: vi.fn() };
    client.runQuery.mockReturnValue({
      getUploadUrls: {
        domain: 'https://asdqwe.chromatic.com',
        urls: [
          {
            path: 'iframe.html',
            url: 'https://asdqwe.chromatic.com/iframe.html',
            contentType: 'text/html',
          },
          {
            path: 'index.html',
            url: 'https://asdqwe.chromatic.com/index.html',
            contentType: 'text/html',
          },
        ],
      },
    });

    createReadStreamMock.mockReturnValue({ pipe: vi.fn((x) => x) } as any);
    progress.mockImplementation((() => {
      let progressCb;
      return {
        on: vi.fn((name, cb) => {
          progressCb = cb;
        }),
        sendProgress: (delta: number) => progressCb({ delta }),
      };
    }) as any);
    http.fetch.mockReset().mockImplementation(async (url, { body }) => {
      // body is just the mocked progress stream, as pipe returns it
      body.sendProgress(21);
      body.sendProgress(21);
      return { ok: true };
    });

    const fileInfo = {
      lengths: [
        { knownAs: 'iframe.html', contentLength: 42 },
        { knownAs: 'index.html', contentLength: 42 },
      ],
      paths: ['iframe.html', 'index.html'],
      total: 84,
    };
    const ctx = {
      client,
      env,
      log,
      http,
      sourceDir: '/static/',
      options: { experimental_onTaskProgress: vi.fn() },
      fileInfo,
      announcedBuild: { id: '1' },
    } as any;
    await uploadStorybook(ctx, {} as any);

    expect(ctx.options.experimental_onTaskProgress).toHaveBeenCalledTimes(4);
    expect(ctx.options.experimental_onTaskProgress).toHaveBeenCalledWith(expect.any(Object), {
      progress: 21,
      total: 84,
      unit: 'bytes',
    });
    expect(ctx.options.experimental_onTaskProgress).toHaveBeenCalledWith(expect.any(Object), {
      progress: 42,
      total: 84,
      unit: 'bytes',
    });
    expect(ctx.options.experimental_onTaskProgress).toHaveBeenCalledWith(expect.any(Object), {
      progress: 63,
      total: 84,
      unit: 'bytes',
    });
    expect(ctx.options.experimental_onTaskProgress).toHaveBeenCalledWith(expect.any(Object), {
      progress: 84,
      total: 84,
      unit: 'bytes',
    });
  });

  describe('with zip', () => {
    it('retrieves the upload location, adds the files to an archive and uploads it', async () => {
      const client = { runQuery: vi.fn() };
      client.runQuery.mockReturnValue({
        getZipUploadUrl: {
          domain: 'https://asdqwe.chromatic.com',
          url: 'https://asdqwe.chromatic.com/storybook.zip',
          sentinelUrl: 'https://asdqwe.chromatic.com/upload.txt',
        },
      });

      makeZipFile.mockReturnValue(Promise.resolve({ path: 'storybook.zip', size: 80 }));
      createReadStreamMock.mockReturnValue({ pipe: vi.fn() } as any);
      http.fetch.mockReturnValue({ ok: true, text: () => Promise.resolve('OK') });
      progress.mockReturnValue({ on: vi.fn() } as any);

      const fileInfo = {
        lengths: [
          { knownAs: 'iframe.html', contentLength: 42 },
          { knownAs: 'index.html', contentLength: 42 },
        ],
        paths: ['iframe.html', 'index.html'],
        total: 84,
      };
      const ctx = {
        client,
        env,
        log,
        http,
        sourceDir: '/static/',
        options: { zip: true },
        fileInfo,
        announcedBuild: { id: '1' },
      } as any;
      await uploadStorybook(ctx, {} as any);

      expect(client.runQuery).toHaveBeenCalledWith(
        expect.stringMatching(/GetZipUploadUrlMutation/),
        { buildId: '1' }
      );
      expect(http.fetch).toHaveBeenCalledWith(
        'https://asdqwe.chromatic.com/storybook.zip',
        expect.objectContaining({
          method: 'PUT',
          headers: {
            'content-type': 'application/zip',
            'content-length': '80',
          },
        }),
        expect.objectContaining({ retries: 0 })
      );
      expect(ctx.uploadedBytes).toBe(80);
    });
  });
});
