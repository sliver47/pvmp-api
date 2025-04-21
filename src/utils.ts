import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import xml2js from 'xml2js';
import os from 'os';
import fetch from 'node-fetch';

import { CONSTANTS } from './constants';
import { Extension } from './models/extension';
import { Package } from './models/package';
import { Manifest } from './types/XmlManifest';
import { PackageJson } from './types/PackageJson';

/**
 * Recursively gets paths of extensions inside a directory.
 * @param dir - The directory to start searching for extensions.
 * @param depth - The depth of recursion.
 * @param extensionPaths - Array to store found extension paths.
 * @returns An array of extension paths.
 */
const getExtensionPathsRecursively = (dir: string, depth: number, extensionPaths: string[] = []): string[] => {
  if (depth <= 0) {
    return extensionPaths;
  }

  try {
    const contents = fs.readdirSync(dir, { withFileTypes: true });

    for (const content of contents) {
      const fullPath = path.join(dir, content.name);

      if (content.isDirectory()) {
        extensionPaths = getExtensionPathsRecursively(fullPath, depth - 1, extensionPaths);
      } else if (content.name.endsWith('.vsix')) {
        extensionPaths.push(fullPath);
      }
    }
  } catch (err) {
    console.log(err);
  }

  return extensionPaths;
};

/**
 * Gets the list of packages (collections of extensions) in a directory.
 * @param dir - The directory to search for extensions.
 * @returns A promise resolving to an array of packages.
 */
export const getPackages = async (dirs: string[]): Promise<Package[]> => {
  const packages: Package[] = [];
  const extensions = await getExtensions(dirs);
  if (!extensions?.length) return [];

  for (const extension of extensions) {
    let packageIndex = packages.findIndex((x) => x.id === extension.id);
    if (packageIndex === -1) {
      const pkg = new Package();
      pkg.id = extension.id;
      pkg.installedVersion = getExtensionInstalledVersion(extension.metadata.identifier);
      packages.push(pkg);
      packageIndex = packages.length - 1;
    }

    packages[packageIndex].addExtension(extension);
  }

  packages.map((x) => x.sort());

  return packages;
};

/**
 * Gets the list of extensions in a directory.
 * @param dir - The directory to search for extensions.
 * @returns A promise resolving to an array of extensions.
 */
const getExtensions = async (dirs: string[]): Promise<Extension[]> => {
  const extensionPaths = dirs.map((dir) => getExtensionPathsRecursively(dir, 3)).flat();
  const extensions: Extension[] = [];
  const parser = new xml2js.Parser({ explicitArray: false });

  for (const extensionPath of extensionPaths) {
    const zip = new AdmZip(extensionPath);
    const extManifest = (await parser.parseStringPromise(zip.readAsText('extension.vsixmanifest'))) as Manifest;
    const npmManifest = JSON.parse(zip.readAsText('extension/package.json')) as PackageJson;
    const extension = new Extension();

    const PackageManifest = extManifest?.PackageManifest;
    if (!PackageManifest) continue;

    extension.identity.target = PackageManifest.Metadata?.Identity?.$?.TargetPlatform || 'any';
    if (!isCompatibleTarget(extension.identity.target)) continue;

    /* BASE */
    extension.name = PackageManifest.Metadata?.DisplayName;
    extension.id = PackageManifest.Metadata?.Identity?.$?.Id;
    extension.extensionPath = extensionPath;

    const propertiesArray = PackageManifest.Metadata?.Properties?.Property || [];

    /* IDENTIFY */
    extension.identity.version = PackageManifest.Metadata?.Identity?.$?.Version;
    extension.identity.preRelease = !!propertiesArray.find(
      (prop) => prop?.$?.Id === 'Microsoft.VisualStudio.Code.PreRelease'
    );
    extension.identity.preview = npmManifest?.preview;
    extension.identity.engine = npmManifest?.engines?.vscode || '*';

    /* METADATA */
    extension.metadata.description = PackageManifest.Metadata?.Description?._;
    extension.metadata.publisher = PackageManifest.Metadata?.Identity?.$?.Publisher;
    extension.metadata.publishedAt = fs.statSync(extensionPath).ctime;
    extension.metadata.identifier = `${extension.metadata.publisher.toLowerCase()}.${extension.id.toLowerCase()}`;
    extension.metadata.language = PackageManifest.Metadata?.Identity?.$?.Language || 'en-US';
    extension.metadata.categories = npmManifest.categories || [];

    /* ASSETS */
    const readmePath = PackageManifest.Assets?.Asset?.find(
      (asset) => asset?.$?.Type === 'Microsoft.VisualStudio.Services.Content.Details'
    )?.$?.Path;
    const changelogPath = PackageManifest.Assets?.Asset?.find(
      (asset) => asset?.$?.Type === 'Microsoft.VisualStudio.Services.Content.Changelog'
    )?.$?.Path;
    const imagePath = PackageManifest.Metadata?.Icon;

    extension.assets.readme = readmePath ? zip.readAsText(readmePath) : '';
    extension.assets.changelog = changelogPath ? zip.readAsText(changelogPath) : '';
    extension.assets.image = imagePath
      ? `data:image/png;base64,${Buffer.from(zip.readFile(imagePath) as Buffer).toString('base64')}`
      : '';

    /* LINKS */
    extension.links.getStarted = propertiesArray?.find((x) => x?.$?.Id?.endsWith('Links.Getstarted'))?.$?.Value || '';
    extension.links.learn = propertiesArray?.find((x) => x?.$?.Id?.endsWith('Links.Learn'))?.$?.Value || '';
    extension.links.repository = propertiesArray?.find((x) => x?.$?.Id?.endsWith('Links.Repository'))?.$?.Value || '';
    extension.links.support = propertiesArray?.find((x) => x?.$?.Id?.endsWith('Links.Support'))?.$?.Value || '';

    extensions.push(extension);
  }

  return extensions;
};

/**
 * Checks if the extension target is compatible with the current platform.
 * @param target - The target platform of the extension.
 * @returns True if the target is compatible; otherwise, false.
 */
const isCompatibleTarget = (target: string): boolean => {
  const targetPlatform = `${process.platform}-${process.arch}`;
  if (target === 'any' || targetPlatform.toLowerCase() === target.toLowerCase()) {
    return true;
  }
  return false;
};

/**
 * Gets the installed version of an extension using its identifier.
 * @param identifier - The identifier of the extension.
 * @returns The installed version of the extension.
 */
const getExtensionInstalledVersion = (identifier: string): string => {
  const ext = vscode.extensions.getExtension(identifier);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
  return ext?.packageJSON?.version;
};

/**
 * Installs an extension from a package.
 * @param pkg - The package containing the extension to install.
 * @param ctx - The VSCode extension context.
 * @returns A promise resolving to the installed version of the extension.
 */
export const installExtension = async (pkg: Package, ctx: vscode.ExtensionContext): Promise<string> => {
  const downloadDir = downloadDirectoryExists(ctx);
  const copiedExtensionPath = path.join(downloadDir, path.basename(pkg.extension.extensionPath));

  if (!fs.existsSync(pkg.extension.extensionPath)) {
    await vscode.window.showErrorMessage(
      `Failed to install ${pkg.extension.id}:v${pkg.extension.identity.version} visx file doesn't exist`
    );
    return '';
  }

  // Copy extension to the download directory
  fs.copyFileSync(pkg.extension.extensionPath, copiedExtensionPath);

  try {
    // Install the extension
    await vscode.commands.executeCommand(CONSTANTS.vsCmdInstall, vscode.Uri.file(copiedExtensionPath));

    // Cleanup
    fs.rmSync(copiedExtensionPath);

    vscode.window.showInformationMessage(
      `Successfully installed ${pkg.extension.id}:v${pkg.extension.identity.version}`
    );
    return pkg.extension.identity.version;
  } catch (err: unknown) {
    console.error(err);
    await vscode.window.showErrorMessage(
      `Failed to install ${pkg.extension.id}:v${pkg.extension.identity.version} with error ${String(err)}`
    );
  }

  return '';
};

/**
 * Batch updates a list of VS Code extensions.
 *
 * @param {Package[]} pkgs - The list of packages to update.
 * @param {vscode.ExtensionContext} ctx - The VS Code extension context.
 * @returns {Promise<void>} A promise that resolves once the batch update is complete.
 */
export const batchUpdateExtensions = async (pkgs: Package[], ctx: vscode.ExtensionContext): Promise<void> => {
  const downloadDir = downloadDirectoryExists(ctx);
  const failedIds = ((await vscode.workspace.getConfiguration('')?.get(CONSTANTS.propFailedUpdates)) as string[]) || [];
  let updated = 0;

  for (const pkg of pkgs) {
    if (failedIds.includes(pkg.extension.id + pkg.extension.identity.version)) continue;
    pkg.selectedIndex = 0; //latest version
    const copiedExtensionPath = path.join(downloadDir, path.basename(pkg.extension.extensionPath));
    fs.copyFileSync(pkg.extension.extensionPath, copiedExtensionPath);

    try {
      console.log(copiedExtensionPath);
      // Install the extension
      await vscode.commands.executeCommand(CONSTANTS.vsCmdInstall, vscode.Uri.file(copiedExtensionPath));
      // Cleanup
      fs.rmSync(copiedExtensionPath);
      updated++;
    } catch (err: unknown) {
      console.error(err);
      await vscode.window.showErrorMessage(
        `Failed to install ${pkg.extension.id}:v${pkg.extension.identity.version} with error ${String(err)}`
      );
      failedIds.push(pkg.extension.id + pkg.extension.identity.version);
    }
  }

  if (failedIds.length)
    await vscode.workspace
      .getConfiguration('')
      ?.update(CONSTANTS.propFailedUpdates, failedIds, vscode.ConfigurationTarget.Global);
  if (updated) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
};

/**
 * Uninstalls an extension.
 * @param pkg - The package containing the extension to uninstall.
 * @returns A promise resolving to true if uninstallation is successful; otherwise, false.
 */
export const uninstallExtension = async (pkg: Package): Promise<boolean> => {
  try {
    // Uninstall the extension
    await vscode.commands.executeCommand(CONSTANTS.vsCmdUninstall, pkg.extension.metadata.identifier);

    vscode.window.showInformationMessage(`Successfully uninstalled ${pkg.extension.id}:v${pkg.installedVersion}`);
    return true;
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Failed to uninstall ${pkg.extension.id}:v${pkg.installedVersion} with error ${String(err)}`
    );
  }
  return false;
};

/**
 * Checks if the download directory exists and creates it if necessary.
 * @param ctx - The VSCode extension context.
 * @returns The path to the download directory.
 */
const downloadDirectoryExists = (ctx: vscode.ExtensionContext): string => {
  const downloadDir = vscode.Uri.joinPath(ctx.globalStorageUri, 'temp');

  if (!fs.existsSync(downloadDir.fsPath)) {
    fs.mkdirSync(downloadDir.fsPath, { recursive: true });
  }

  return downloadDir.fsPath;
};

/**
 * Resolves VSCode variables like ${workspaceFolder} in a given path.
 * @param inputPath The path that may contain VSCode variables.
 * @returns The path with VSCode variables resolved to actual values.
 */
const resolveVariables = (inputPath: string): string => {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

  const replacements: { [key: string]: string } = {
    '${workspaceFolder}': workspaceFolder,
  };

  return inputPath.replace(/\$\{[^}]+\}/g, (match) => replacements[match] || match);
};

/**
 * 根据配置获取扩展源：本地目录列表或 API 拉取
 */
export const getExtensionSources = async (): Promise<string[]> => {
  const config = vscode.workspace.getConfiguration('privateMarketplace');
  const useApi = config.get<boolean>('useApi') || false;
  if (useApi) {
    const apiUrl = config.get<string>('apiUrl')?.trim();
    if (!apiUrl) {
      vscode.window.showErrorMessage('privateMarketplace.apiUrl 未配置');
      return [];
    }
    try {
      const resp = await fetch(apiUrl);
      const urls: string[] = (await resp.json()) as string[];
      return await downloadVsixFiles(urls);
    } catch (err: unknown) {
      console.error(err);
      vscode.window.showErrorMessage(`调用扩展列表接口失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  // 兼容旧逻辑：读取本地文件夹
  const dirs = config.get<string[]>('source') || [];
  return dirs.map(resolveVariables);
};

export const getWebviewOptions = (extensionUri: vscode.Uri): vscode.WebviewOptions => {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'out')],
  };
};

/**
 * 下载远程 .vsix 文件到本地临时目录
 */
async function downloadVsixFiles(urls: string[]): Promise<string[]> {
  const tempDir = path.join(os.tmpdir(), 'pvmp-vsix');
  await fs.promises.mkdir(tempDir, { recursive: true });
  const localPaths: string[] = [];
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) {
      vscode.window.showErrorMessage(`下载扩展失败：${url} → ${res.statusText}`);
      continue;
    }
    const buffer = await res.buffer();
    const fileName = path.basename(new URL(url).pathname);
    const filePath = path.join(tempDir, fileName);
    await fs.promises.writeFile(filePath, buffer);
    localPaths.push(filePath);
  }
  return localPaths;
}
