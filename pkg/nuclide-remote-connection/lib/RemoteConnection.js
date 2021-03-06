/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {HgRepositoryDescription} from '../../nuclide-source-control-helpers';

import typeof * as FileWatcherServiceType from '../../nuclide-filewatcher-rpc';
import typeof * as FileSystemServiceType from '../../nuclide-server/lib/services/FileSystemService';
import typeof * as SourceControlService from '../../nuclide-server/lib/services/SourceControlService';
import type {RemoteFile} from './RemoteFile';
import type {RemoteDirectory} from './RemoteDirectory';
import type {ServerConnectionVersion} from './ServerConnection';

import invariant from 'assert';
import season from 'season';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import lookupPreferIpv6 from './lookup-prefer-ip-v6';
import {ServerConnection} from './ServerConnection';
import {Emitter} from 'atom';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {getConnectionConfig} from './RemoteConnectionConfigurationManager';
import {getLogger} from 'log4js';
import toml from 'toml';

const logger = getLogger('nuclide-remote-connection');

const FILE_WATCHER_SERVICE = 'FileWatcherService';
const FILE_SYSTEM_SERVICE = 'FileSystemService';

export type RemoteConnectionConfiguration = {
  host: string, // host nuclide server is running on.
  port: number, // port to connect to.
  family?: 4 | 6, // ipv4 or ipv6?
  cwd: string, // Path to remote directory user should start in upon connection.
  displayTitle: string, // Name of the saved connection profile.
  certificateAuthorityCertificate?: Buffer, // certificate of certificate authority.
  clientCertificate?: Buffer, // client certificate for https connection.
  clientKey?: Buffer, // key for https connection.
  promptReconnectOnFailure?: boolean, // open a connection dialog prompt if the reconnect fails
  version?: ServerConnectionVersion,
};

// A RemoteConnection represents a directory which has been opened in Nuclide on a remote machine.
// This corresponds to what atom calls a 'root path' in a project.
//
// TODO: The _entries and _hgRepositoryDescription should not be here.
// Nuclide behaves badly when remote directories are opened which are parent/child of each other.
// And there needn't be a 1:1 relationship between RemoteConnections and hg repos.
export class RemoteConnection {
  _cwd: string; // Path to remote directory user should start in upon connection.
  _subscriptions: UniversalDisposable;
  _hgRepositoryDescription: ?HgRepositoryDescription;
  _connection: ServerConnection;
  _displayTitle: string;
  _alwaysShutdownIfLast: boolean;
  _promptReconnectOnFailure: boolean;

  static _emitter = new Emitter();

  static async findOrCreate(
    config: RemoteConnectionConfiguration,
  ): Promise<RemoteConnection> {
    const serverConnection = await ServerConnection.getOrCreate(config);
    const {cwd, displayTitle, promptReconnectOnFailure} = config;
    const directories = [];

    try {
      const fsService: FileSystemServiceType = serverConnection.getService(
        FILE_SYSTEM_SERVICE,
      );

      const realPath = await fsService.resolveRealPath(cwd);

      // realPath may actually be a project file.
      const contents = hasAtomProjectFormat(realPath)
        ? await fsService.readFile(realPath).catch(() => null)
        : null;

      // If the file is not a project file, initialize the connection.
      if (contents == null) {
        // Now that we know the real path, it's possible this collides with an existing connection.
        if (realPath !== cwd && nuclideUri.isRemote(cwd)) {
          const existingConnection = this.getByHostnameAndPath(
            nuclideUri.getHostname(cwd),
            realPath,
          );
          if (existingConnection != null) {
            return existingConnection;
          }
        }
        directories.push(realPath);
      } else {
        const projectContents = parseProject(contents.toString());
        const dirname = nuclideUri.dirname(realPath);

        const projectPaths = projectContents.paths;
        if (projectPaths != null && Array.isArray(projectPaths)) {
          directories.push(
            ...projectPaths.map(path => nuclideUri.resolve(dirname, path)),
          );
        } else {
          directories.push(dirname);
        }

        if (atom.project.replace != null) {
          projectContents.paths = directories;
          projectContents.originPath = realPath;
          atom.project.replace(projectContents);
        }
      }
    } catch (err) {
      // Don't leave server connections hanging:
      // if we created a server connection from getOrCreate but failed above
      // then we need to make sure the connection gets closed.
      if (serverConnection.getConnections().length === 0) {
        serverConnection.close();
      }
      throw err;
    }
    const connections = await Promise.all(
      directories.map((dir, i) => {
        const connection = new RemoteConnection(
          serverConnection,
          dir,
          i === 0 ? displayTitle : '',
          promptReconnectOnFailure !== false, // default: true
        );
        return connection._initialize();
      }),
    );
    // We need to return one connection from this function,
    // even though many connections are being created to support projects.
    return connections[0];
  }

  // Do NOT call this directly. Use findOrCreate instead.
  constructor(
    connection: ServerConnection,
    cwd: string,
    displayTitle: string,
    promptReconnectOnFailure: boolean,
  ) {
    this._cwd = cwd;
    this._subscriptions = new UniversalDisposable();
    this._hgRepositoryDescription = null;
    this._connection = connection;
    this._displayTitle = displayTitle;
    this._alwaysShutdownIfLast = false;
    this._promptReconnectOnFailure = promptReconnectOnFailure;
  }

  static _createInsecureConnectionForTesting(
    cwd: string,
    port: number,
  ): Promise<RemoteConnection> {
    const config = {
      host: 'localhost',
      port,
      cwd,
      displayTitle: '',
    };
    return RemoteConnection.findOrCreate(config);
  }

  /**
   * Create a connection by reusing the configuration of last successful connection associated with
   * given host. If the server's certs has been updated or there is no previous successful
   * connection, null (resolved by promise) is returned.
   * Configurations may also be retrieved by IP address.
   */
  static async _createConnectionBySavedConfig(
    host: string,
    cwd: string,
    displayTitle: string,
    promptReconnectOnFailure: boolean = true,
  ): Promise<?RemoteConnection> {
    const connectionConfig = await getConnectionConfig(host);
    if (!connectionConfig) {
      return null;
    }
    try {
      const config = {
        ...connectionConfig,
        cwd,
        displayTitle,
        promptReconnectOnFailure,
      };
      return await RemoteConnection.findOrCreate(config);
    } catch (e) {
      // Returning null from this method signals that we should
      // should restart the handshake process with same config.
      // But there are some errors for which we don't want to do that
      // (like if the connection fails because the directory doesn't exist).
      if (e.code === 'ENOENT') {
        e.sshHandshakeErrorType = 'DIRECTORY_NOT_FOUND';
        throw e;
      }

      const log =
        e.name === 'VersionMismatchError'
          ? logger.warn.bind(logger)
          : logger.error.bind(logger);

      log(`Failed to reuse connectionConfiguration for ${host}`, e);
      return null;
    }
  }

  /**
   * Attempts to connect to an open or previously open remote connection.
   */
  static async reconnect(
    host: string,
    cwd: string,
    displayTitle: string,
    promptReconnectOnFailure: boolean = true,
  ): Promise<?RemoteConnection> {
    logger.info('Attempting to reconnect', {
      host,
      cwd,
      displayTitle,
      promptReconnectOnFailure,
    });

    if (!hasAtomProjectFormat(cwd)) {
      const connection = RemoteConnection.getByHostnameAndPath(host, cwd);

      if (connection != null) {
        return connection;
      }
    }

    let connection = await RemoteConnection._createConnectionBySavedConfig(
      host,
      cwd,
      displayTitle,
      promptReconnectOnFailure,
    );
    if (connection == null) {
      try {
        // Connection configs are also stored by IP address to share between hostnames.
        const {address} = await lookupPreferIpv6(host);
        connection = await RemoteConnection._createConnectionBySavedConfig(
          address,
          cwd,
          displayTitle,
          promptReconnectOnFailure,
        );
      } catch (err) {
        // It's OK if the backup IP check fails.
      }
    }
    return connection;
  }

  // A workaround before Atom 2.0: Atom's Project::setPaths currently uses
  // ::repositoryForDirectorySync, so we need the repo information to already be
  // available when the new path is added. t6913624 tracks cleanup of this.
  async _setHgRepoInfo(): Promise<void> {
    const remotePath = this.getPathForInitialWorkingDirectory();
    const {getHgRepository} = (this.getService(
      'SourceControlService',
    ): SourceControlService);
    this._setHgRepositoryDescription(await getHgRepository(remotePath));
  }

  getUriOfRemotePath(remotePath: string): string {
    return `nuclide://${this.getRemoteHostname()}${remotePath}`;
  }

  getPathOfUri(uri: string): string {
    return nuclideUri.parse(uri).path;
  }

  createDirectory(uri: string, symlink: boolean = false): RemoteDirectory {
    return this._connection.createDirectory(
      uri,
      this._hgRepositoryDescription,
      symlink,
    );
  }

  // A workaround before Atom 2.0: see ::getHgRepoInfo of main.js.
  _setHgRepositoryDescription(
    hgRepositoryDescription: ?HgRepositoryDescription,
  ): void {
    this._hgRepositoryDescription = hgRepositoryDescription;
  }

  getHgRepositoryDescription(): ?HgRepositoryDescription {
    return this._hgRepositoryDescription;
  }

  createFile(uri: string, symlink: boolean = false): RemoteFile {
    return this._connection.createFile(uri, symlink);
  }

  async _initialize(): Promise<RemoteConnection> {
    const attemptShutdown = false;
    // Must add first to prevent the ServerConnection from going away
    // in a possible race.
    this._connection.addConnection(this);
    try {
      // A workaround before Atom 2.0: see ::getHgRepoInfo.
      await this._setHgRepoInfo();

      RemoteConnection._emitter.emit('did-add', this);
      this._watchRootProjectDirectory();
    } catch (e) {
      this.close(attemptShutdown);
      throw e;
    }
    return this;
  }

  _watchRootProjectDirectory(): void {
    const rootDirectoryUri = this.getUriForInitialWorkingDirectory();
    const rootDirectoryPath = this.getPathForInitialWorkingDirectory();
    const FileWatcherService: FileWatcherServiceType = this.getService(
      FILE_WATCHER_SERVICE,
    );
    invariant(FileWatcherService);
    const {watchDirectoryRecursive} = FileWatcherService;
    // Start watching the project for changes and initialize the root watcher
    // for next calls to `watchFile` and `watchDirectory`.
    const watchStream = watchDirectoryRecursive(rootDirectoryUri).refCount();
    const subscription = watchStream.subscribe(
      watchUpdate => {
        // Nothing needs to be done if the root directory was watched correctly.
        // Let's just console log it anyway.
        logger.info(
          `Watcher Features Initialized for project: ${rootDirectoryUri}`,
          watchUpdate,
        );
      },
      async error => {
        let warningMessageToUser = '';
        let detail;
        const fileSystemService: FileSystemServiceType = this.getService(
          FILE_SYSTEM_SERVICE,
        );
        if (await fileSystemService.isNfs(rootDirectoryUri)) {
          warningMessageToUser +=
            `This project directory: \`${rootDirectoryPath}\` is on <b>\`NFS\`</b> filesystem. ` +
            'Nuclide works best with local (non-NFS) root directory.' +
            'e.g. `/data/users/$USER`' +
            'features such as synced remote file editing, file search, ' +
            'and Mercurial-related updates will not work.<br/>';
        } else {
          warningMessageToUser +=
            'You just connected to a remote project ' +
            `\`${rootDirectoryPath}\` without Watchman support, which means that ` +
            'crucial features such as synced remote file editing, file search, ' +
            'and Mercurial-related updates will not work.';

          const watchmanConfig = await fileSystemService
            .findNearestAncestorNamed('.watchmanconfig', rootDirectoryUri)
            .catch(() => null);
          if (watchmanConfig == null) {
            warningMessageToUser +=
              '<br/><br/>A possible workaround is to create an empty `.watchmanconfig` file ' +
              'in the remote folder, which will enable Watchman if you have it installed.';
          }
          detail = error.message || error;
          logger.error(
            'Watchman failed to start - watcher features disabled!',
            error,
          );
        }
        // Add a persistent warning message to make sure the user sees it before dismissing.
        atom.notifications.addWarning(warningMessageToUser, {
          dismissable: true,
          detail,
        });
      },
      () => {
        // Nothing needs to be done if the root directory watch has ended.
        logger.info(`Watcher Features Ended for project: ${rootDirectoryUri}`);
      },
    );
    this._subscriptions.add(subscription);
  }

  async close(shutdownIfLast: boolean): Promise<void> {
    logger.info('Received close command!', {
      shutdownIfLast,
      stack: Error('stack').stack,
    });
    this._subscriptions.dispose();
    await this._connection.removeConnection(this, shutdownIfLast);
    RemoteConnection._emitter.emit('did-close', this);
  }

  getConnection(): ServerConnection {
    return this._connection;
  }

  getPort(): number {
    return this._connection.getPort();
  }

  getRemoteHostname(): string {
    return this._connection.getRemoteHostname();
  }

  getDisplayTitle(): string {
    return this._displayTitle;
  }

  getUriForInitialWorkingDirectory(): string {
    return this.getUriOfRemotePath(this.getPathForInitialWorkingDirectory());
  }

  getPathForInitialWorkingDirectory(): string {
    return this._cwd;
  }

  getConfig(): RemoteConnectionConfiguration {
    return {
      ...this._connection.getConfig(),
      cwd: this._cwd,
      displayTitle: this._displayTitle,
      promptReconnectOnFailure: this._promptReconnectOnFailure,
    };
  }

  static onDidAddRemoteConnection(
    handler: (connection: RemoteConnection) => void,
  ): IDisposable {
    return RemoteConnection._emitter.on('did-add', handler);
  }

  static onDidCloseRemoteConnection(
    handler: (connection: RemoteConnection) => void,
  ): IDisposable {
    return RemoteConnection._emitter.on('did-close', handler);
  }

  static getForUri(uri: NuclideUri): ?RemoteConnection {
    const {hostname, path} = nuclideUri.parse(uri);
    if (hostname == null) {
      return null;
    }
    return RemoteConnection.getByHostnameAndPath(hostname, path);
  }

  /**
   * Get cached connection match the hostname and the path has the prefix of connection.cwd.
   * @param hostname The connected server host name.
   * @param path The absolute path that's has the prefix of cwd of the connection.
   *   If path is null, empty or undefined, then return the connection which matches
   *   the hostname and ignore the initial working directory.
   */
  static getByHostnameAndPath(
    hostname: string,
    path: string,
  ): ?RemoteConnection {
    return RemoteConnection.getByHostname(hostname).filter(connection => {
      return path.startsWith(connection.getPathForInitialWorkingDirectory());
    })[0];
  }

  static getByHostname(hostname: string): Array<RemoteConnection> {
    const server = ServerConnection.getByHostname(hostname);
    return server == null ? [] : server.getConnections();
  }

  getService(serviceName: string): any {
    return this._connection.getService(serviceName);
  }

  isOnlyConnection(): boolean {
    return this._connection.getConnections().length === 1;
  }

  setAlwaysShutdownIfLast(alwaysShutdownIfLast: boolean): void {
    this._alwaysShutdownIfLast = alwaysShutdownIfLast;
  }

  alwaysShutdownIfLast(): boolean {
    return this._alwaysShutdownIfLast;
  }
}

function hasAtomProjectFormat(filepath) {
  const ext = nuclideUri.extname(filepath);
  return ext === '.json' || ext === '.cson';
}

function parseProject(raw: string): any {
  try {
    return toml.parse(raw);
  } catch (err) {
    if (err.name === 'SyntaxError') {
      return season.parse(raw);
    }
    throw err;
  }
}
