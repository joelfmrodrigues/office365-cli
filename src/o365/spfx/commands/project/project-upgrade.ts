import commands from '../../commands';
import Command, {
  CommandOption, CommandError, CommandAction, CommandValidate
} from '../../../../Command';
import GlobalOptions from '../../../../GlobalOptions';
import * as path from 'path';
import * as fs from 'fs';
import { Finding, Utils, Hash, Dictionary } from './project-upgrade/';
import { Rule } from './project-upgrade/rules/Rule';
import * as os from 'os';
import { Project, Manifest, TsFile, ScssFile } from './project-upgrade/model';
import { FindingToReport } from './project-upgrade/FindingToReport';
import { FN017001_MISC_npm_dedupe } from './project-upgrade/rules/FN017001_MISC_npm_dedupe';
import { ReportData, ReportDataModification } from './ReportData';

const vorpal: Vorpal = require('../../../../vorpal-init');

interface CommandArgs {
  options: Options;
}

interface Options extends GlobalOptions {
  outputFile?: string;
  packageManager?: string;
  toVersion?: string;
  shell?: string;
}

class SpfxProjectUpgradeCommand extends Command {
  private projectVersion: string | undefined;
  private toVersion: string = '';
  private packageManager: string = 'npm';
  private shell: string = 'bash';
  private projectRootPath: string | null = null;
  private allFindings: Finding[] = [];
  private supportedVersions: string[] = [
    '1.0.0',
    '1.0.1',
    '1.0.2',
    '1.1.0',
    '1.1.1',
    '1.1.3',
    '1.2.0',
    '1.3.0',
    '1.3.1',
    '1.3.2',
    '1.3.4',
    '1.4.0',
    '1.4.1',
    '1.5.0',
    '1.5.1',
    '1.6.0',
    '1.7.0',
    '1.7.1',
    '1.8.0',
    '1.8.1',
    '1.8.2',
    '1.9.1',
    '1.10.0'
  ];
  private static packageCommands = {
    npm: {
      install: 'npm i -SE',
      installDev: 'npm i -DE',
      uninstall: 'npm un -S',
      uninstallDev: 'npm un -D'
    },
    pnpm: {
      install: 'pnpm i -E',
      installDev: 'pnpm i -DE',
      uninstall: 'pnpm un',
      uninstallDev: 'pnpm un'
    },
    yarn: {
      install: 'yarn add -E',
      installDev: 'yarn add -DE',
      uninstall: 'yarn remove',
      uninstallDev: 'yarn remove'
    }
  }

  private static copyCommands = {
    bash: {
      copyCommand: 'cp',
      copyDestinationParam: ' '
    },
    powershell: {
      copyCommand: 'Copy-Item',
      copyDestinationParam: ' -Destination '
    },
    cmd: {
      copyCommand: 'copy',
      copyDestinationParam: ' '
    }
  }

  private static createDirectoryCommands = {
    bash: {
      createDirectoryCommand: 'mkdir',
      createDirectoryPathParam: ' ',
      createDirectoryNameParam: '/',
      createDirectoryItemTypeParam: '',
    },
    powershell: {
      createDirectoryCommand: 'New-Item',
      createDirectoryPathParam: ' -Path "',
      createDirectoryNameParam: '" -Name "',
      createDirectoryItemTypeParam: '" -ItemType "directory"',
    },
    cmd: {
      createDirectoryCommand: 'mkdir',
      createDirectoryPathParam: ' "',
      createDirectoryNameParam: '\\',
      createDirectoryItemTypeParam: '"',
    }
  }

  private static addFileCommands = {
    bash: {
      addFileCommand: 'cat > [FILEPATH] << EOF [FILECONTENT]EOF',
    },
    powershell: {
      addFileCommand: `@"[FILECONTENT]"@ | Out-File -FilePath "[FILEPATH]"
      `,
    },
    cmd: {
      addFileCommand: `echo [FILECONTENT] > "[FILEPATH]"
      `,
    }
  }

  private static removeFileCommands = {
    bash: {
      removeFileCommand: 'rm',
    },
    powershell: {
      removeFileCommand: 'Remove-Item',
    },
    cmd: {
      removeFileCommand: 'del',
    }
  }

  public static ERROR_NO_PROJECT_ROOT_FOLDER: number = 1;
  public static ERROR_UNSUPPORTED_TO_VERSION: number = 2;
  public static ERROR_NO_VERSION: number = 3;
  public static ERROR_UNSUPPORTED_FROM_VERSION: number = 4;
  public static ERROR_NO_DOWNGRADE: number = 5;
  public static ERROR_PROJECT_UP_TO_DATE: number = 6;

  public get name(): string {
    return commands.PROJECT_UPGRADE;
  }

  public get description(): string {
    return 'Upgrades SharePoint Framework project to the specified version';
  }

  public getTelemetryProperties(args: CommandArgs): any {
    const telemetryProps: any = super.getTelemetryProperties(args);
    telemetryProps.toVersion = args.options.toVersion || this.supportedVersions[this.supportedVersions.length - 1];
    telemetryProps.packageManager = args.options.packageManager || 'npm';
    telemetryProps.shell = args.options.shell || 'bash';
    telemetryProps.outputFile = typeof args.options.outputFile !== 'undefined';
    return telemetryProps;
  }

  public action(): CommandAction {
    const cmd: Command = this;
    return function (this: CommandInstance, args: CommandArgs, cb: (err?: any) => void) {
      args = (cmd as any).processArgs(args);
      (cmd as any).initAction(args, this);
      cmd.commandAction(this, args, cb);
    }
  }

  public commandAction(cmd: CommandInstance, args: CommandArgs, cb: (err?: any) => void): void {
    this.projectRootPath = this.getProjectRoot(process.cwd());
    if (this.projectRootPath === null) {
      cb(new CommandError(`Couldn't find project root folder`, SpfxProjectUpgradeCommand.ERROR_NO_PROJECT_ROOT_FOLDER));
      return;
    }

    this.toVersion = args.options.toVersion ? args.options.toVersion : this.supportedVersions[this.supportedVersions.length - 1];
    this.packageManager = args.options.packageManager || 'npm';
    this.shell = args.options.shell || 'bash';

    if (this.supportedVersions.indexOf(this.toVersion) < 0) {
      cb(new CommandError(`Office 365 CLI doesn't support upgrading SharePoint Framework projects to version ${this.toVersion}. Supported versions are ${this.supportedVersions.join(', ')}`, SpfxProjectUpgradeCommand.ERROR_UNSUPPORTED_TO_VERSION));
      return;
    }

    this.projectVersion = this.getProjectVersion();
    if (!this.projectVersion) {
      cb(new CommandError(`Unable to determine the version of the current SharePoint Framework project`, SpfxProjectUpgradeCommand.ERROR_NO_VERSION));
      return;
    }

    const pos: number = this.supportedVersions.indexOf(this.projectVersion);
    if (pos < 0) {
      cb(new CommandError(`Office 365 CLI doesn't support upgrading projects build on SharePoint Framework v${this.projectVersion}`, SpfxProjectUpgradeCommand.ERROR_UNSUPPORTED_FROM_VERSION));
      return;
    }

    const posTo: number = this.supportedVersions.indexOf(this.toVersion);
    if (pos > posTo) {
      cb(new CommandError('You cannot downgrade a project', SpfxProjectUpgradeCommand.ERROR_NO_DOWNGRADE));
      return;
    }

    if (pos === posTo) {
      cb(new CommandError('Project doesn\'t need to be upgraded', SpfxProjectUpgradeCommand.ERROR_PROJECT_UP_TO_DATE));
      return;
    }

    if (this.verbose) {
      cmd.log('Collecting project...');
    }
    const project: Project = this.getProject(this.projectRootPath);

    if (this.debug) {
      cmd.log('Collected project');
      cmd.log(project);
    }

    // reverse the list of versions to upgrade to, so that most recent findings
    // will end up on top already. Saves us reversing a larger array later
    const versionsToUpgradeTo: string[] = this.supportedVersions.slice(pos + 1, posTo + 1).reverse();
    try {
      versionsToUpgradeTo.forEach(v => {
        const rules: Rule[] = require(`./project-upgrade/upgrade-${v}`);
        rules.forEach(r => {
          r.visit(project, this.allFindings);
        });
      });
    }
    catch (e) {
      cb(new CommandError(e.message));
      return;
    }
    if (this.packageManager === 'npm') {
      const npmDedupeRule: Rule = new FN017001_MISC_npm_dedupe();
      npmDedupeRule.visit(project, this.allFindings);
    }

    // dedupe
    const findings: Finding[] = this.allFindings.filter((f: Finding, i: number, allFindings: Finding[]) => {
      const firstFindingPos: number = this.allFindings.findIndex(f1 => f1.id === f.id);
      return i === firstFindingPos;
    });

    // remove superseded findings
    findings
      // get findings that supersede other findings
      .filter(f => f.supersedes.length > 0)
      .forEach(f => {
        f.supersedes.forEach(s => {
          // find the superseded finding
          const i: number = findings.findIndex(f1 => f1.id === s);
          if (i > -1) {
            // ...and remove it from findings
            findings.splice(i, 1);
          }
        });
      });

    // flatten
    const findingsToReport: FindingToReport[] = ([] as FindingToReport[]).concat.apply([], findings.map(f => {
      return f.occurrences.map(o => {
        return {
          description: f.description,
          id: f.id,
          file: o.file,
          position: o.position,
          resolution: o.resolution,
          resolutionType: f.resolutionType,
          severity: f.severity,
          title: f.title
        };
      });
    }));

    // replace package operation tokens with command for the specific package manager
    findingsToReport.forEach(f => {
      // matches must be in this particular order to avoid false matches, eg.
      // uninstallDev contains install
      if (f.resolution.startsWith('uninstallDev')) {
        f.resolution = f.resolution.replace('uninstallDev', this.getPackageManagerCommand('uninstallDev'));
        return;
      }
      if (f.resolution.startsWith('installDev')) {
        f.resolution = f.resolution.replace('installDev', this.getPackageManagerCommand('installDev'));
        return;
      }
      if (f.resolution.startsWith('uninstall')) {
        f.resolution = f.resolution.replace('uninstall', this.getPackageManagerCommand('uninstall'));
        return;
      }
      if (f.resolution.startsWith('install')) {
        f.resolution = f.resolution.replace('install', this.getPackageManagerCommand('install'));
        return;
      }

      // copy support for multiple shells
      if (f.resolution.startsWith('copy_cmd')) {
        f.resolution = f.resolution.replace('copy_cmd', this.getCopyCommand('copyCommand'));
        f.resolution = f.resolution.replace('DestinationParam', this.getCopyCommand('copyDestinationParam'));
        return;
      }
      // createdir support for multiple shells
      if (f.resolution.startsWith('create_dir_cmd')) {
        f.resolution = f.resolution.replace('create_dir_cmd', this.getDirectoryCommand('createDirectoryCommand'));
        f.resolution = f.resolution.replace('NameParam', this.getDirectoryCommand('createDirectoryNameParam'));
        f.resolution = f.resolution.replace('PathParam', this.getDirectoryCommand('createDirectoryPathParam'));
        f.resolution = f.resolution.replace('ItemTypeParam', this.getDirectoryCommand('createDirectoryItemTypeParam'));
        return;
      }
      // 'Add' support for multiple shells
      if (f.resolution.startsWith('add_cmd')) {
        const pathStart: number = f.resolution.indexOf('[BEFOREPATH]') + '[BEFOREPATH]'.length;
        const pathEnd: number = f.resolution.indexOf('[AFTERPATH]');
        const filePath: string = f.resolution.substring(pathStart, pathEnd);

        const contentStart: number = f.resolution.indexOf('[BEFORECONTENT]') + '[BEFORECONTENT]'.length;
        const contentEnd: number = f.resolution.indexOf('[AFTERCONTENT]');
        const fileContent: string = f.resolution.substring(contentStart, contentEnd);

        f.resolution = this.getAddCommand('addFileCommand');
        f.resolution = f.resolution.replace('[FILECONTENT]', fileContent)
        f.resolution = f.resolution.replace('[FILEPATH]', filePath);
        f.resolution = f.resolution.replace('[BEFOREPATH]', ' ');
        f.resolution = f.resolution.replace('[AFTERPATH]', ' ');
        f.resolution = f.resolution.replace('[BEFORECONTENT]', ' ');
        f.resolution = f.resolution.replace('[AFTERCONTENT]', ' ');
        return;
      }
      // 'Remove' support for multiple shells
      if (f.resolution.startsWith('remove_cmd')) {
        f.resolution = f.resolution.replace('remove_cmd', this.getRemoveCommand('removeFileCommand'));
        return;
      }
    });

    switch (args.options.output) {
      case 'json':
        this.writeReport(findingsToReport, cmd, args.options);
        break;
      case 'md':
        this.writeReport(this.getMdReport(findingsToReport), cmd, args.options);
        break;
      default:
        this.writeReport(this.getTextReport(findingsToReport), cmd, args.options);
    }

    cb();
  }

  private writeReport(findingsToReport: any, cmd: CommandInstance, options: Options): void {
    if (options.outputFile) {
      fs.writeFileSync(path.resolve(options.outputFile), options.output === 'json' ? JSON.stringify(findingsToReport) : findingsToReport, 'utf-8');
    }
    else {
      cmd.log(findingsToReport);
    }
  }

  private getProject(projectRootPath: string): Project {
    const project: Project = {
      path: projectRootPath
    };

    const configJsonPath: string = path.join(projectRootPath, 'config/config.json');
    if (fs.existsSync(configJsonPath)) {
      try {
        project.configJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(configJsonPath, 'utf-8')));
      }
      catch { }
    }

    const copyAssetsJsonPath: string = path.join(projectRootPath, 'config/copy-assets.json');
    if (fs.existsSync(copyAssetsJsonPath)) {
      try {
        project.copyAssetsJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(copyAssetsJsonPath, 'utf-8')));
      }
      catch { }
    }

    const deployAzureStorageJsonPath: string = path.join(projectRootPath, 'config/deploy-azure-storage.json');
    if (fs.existsSync(deployAzureStorageJsonPath)) {
      try {
        project.deployAzureStorageJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(deployAzureStorageJsonPath, 'utf-8')));
      }
      catch { }
    }

    const packageJsonPath: string = path.join(projectRootPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        project.packageJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(packageJsonPath, 'utf-8')));
      }
      catch { }
    }

    const packageSolutionJsonPath: string = path.join(projectRootPath, 'config/package-solution.json');
    if (fs.existsSync(packageSolutionJsonPath)) {
      try {
        project.packageSolutionJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(packageSolutionJsonPath, 'utf-8')));
      }
      catch { }
    }

    const serveJsonPath: string = path.join(projectRootPath, 'config/serve.json');
    if (fs.existsSync(serveJsonPath)) {
      try {
        project.serveJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(serveJsonPath, 'utf-8')));
      }
      catch { }
    }

    const tsConfigJsonPath: string = path.join(projectRootPath, 'tsconfig.json');
    if (fs.existsSync(tsConfigJsonPath)) {
      try {
        project.tsConfigJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(tsConfigJsonPath, 'utf-8')));
      }
      catch { }
    }

    const tsLintJsonPath: string = path.join(projectRootPath, 'config/tslint.json');
    if (fs.existsSync(tsLintJsonPath)) {
      try {
        project.tsLintJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(tsLintJsonPath, 'utf-8')));
      }
      catch { }
    }

    const tsLintJsonRootPath: string = path.join(projectRootPath, 'tslint.json');
    if (fs.existsSync(tsLintJsonRootPath)) {
      try {
        project.tsLintJsonRoot = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(tsLintJsonRootPath, 'utf-8')));
      }
      catch { }
    }

    const writeManifestJsonPath: string = path.join(projectRootPath, 'config/write-manifests.json');
    if (fs.existsSync(writeManifestJsonPath)) {
      try {
        project.writeManifestsJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(writeManifestJsonPath, 'utf-8')));
      }
      catch { }
    }

    const yoRcJsonPath: string = path.join(projectRootPath, '.yo-rc.json');
    if (fs.existsSync(yoRcJsonPath)) {
      try {
        project.yoRcJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(yoRcJsonPath, 'utf-8')));
      }
      catch { }
    }

    const manifests: Manifest[] = [];
    const files: string[] = Utils.getAllFiles(path.join(projectRootPath, 'src')) as string[];
    files.forEach(f => {
      if (f.endsWith('.manifest.json')) {
        try {
          const manifestStr = Utils.removeSingleLineComments(fs.readFileSync(f, 'utf-8'));
          const manifest: Manifest = JSON.parse(manifestStr);
          manifest.path = f;
          manifests.push(manifest);
        }
        catch { }
      }
    });
    project.manifests = manifests;

    const gulpfileJsPath: string = path.join(projectRootPath, 'gulpfile.js');
    if (fs.existsSync(gulpfileJsPath)) {
      project.gulpfileJs = {
        src: fs.readFileSync(gulpfileJsPath, 'utf-8')
      };
    }

    project.vsCode = {};
    const vsCodeSettingsPath: string = path.join(projectRootPath, '.vscode', 'settings.json');
    if (fs.existsSync(vsCodeSettingsPath)) {
      try {
        project.vsCode.settingsJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(vsCodeSettingsPath, 'utf-8')));
      }
      catch { }
    }

    const vsCodeExtensionsPath: string = path.join(projectRootPath, '.vscode', 'extensions.json');
    if (fs.existsSync(vsCodeExtensionsPath)) {
      try {
        project.vsCode.extensionsJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(vsCodeExtensionsPath, 'utf-8')));
      }
      catch { }
    }

    const vsCodeLaunchPath: string = path.join(projectRootPath, '.vscode', 'launch.json');
    if (fs.existsSync(vsCodeLaunchPath)) {
      try {
        project.vsCode.launchJson = JSON.parse(Utils.removeSingleLineComments(fs.readFileSync(vsCodeLaunchPath, 'utf-8')));
      }
      catch { }
    }

    const srcFiles: string[] = SpfxProjectUpgradeCommand.readdirR(path.join(projectRootPath, 'src')) as string[];
    const tsFiles: string[] = srcFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
    project.tsFiles = tsFiles.map(f => new TsFile(f));

    const scssFiles: string[] = srcFiles.filter(f => f.endsWith('.scss'));
    project.scssFiles = scssFiles.map(f => new ScssFile(f));

    return project;
  }

  private static readdirR(dir: string): string | string[] {
    return fs.statSync(dir).isDirectory()
      ? Array.prototype.concat(...fs.readdirSync(dir).map(f => SpfxProjectUpgradeCommand.readdirR(path.join(dir, f))))
      : dir;
  }

  private getTextReport(findings: FindingToReport[]): string {
    const reportData: ReportData = this.getReportData(findings);
    const s: string[] = [
      'Execute in ' + this.shell, os.EOL,
      '-----------------------', os.EOL,
      (reportData.packageManagerCommands
        .concat(reportData.commandsToExecute
          .filter((command) =>
            command.indexOf(this.getPackageManagerCommand('install')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('installDev')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('uninstall')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('uninstallDev')) === -1))).join(os.EOL), os.EOL,
      os.EOL,
      Object.keys(reportData.modificationPerFile).map(file => {
        return [
          file, os.EOL,
          '-'.repeat(file.length), os.EOL,
          reportData.modificationPerFile[file].map((m: ReportDataModification) => `${m.description}:${os.EOL}${m.modification}${os.EOL}`).join(os.EOL), os.EOL,
        ].join('');
      }).join(os.EOL),
      os.EOL,
    ];

    return s.join('').trim();
  }

  private getMdReport(findings: FindingToReport[]): string {
    const findingsToReport: string[] = [];
    const reportData: ReportData = this.getReportData(findings);

    findings.forEach(f => {
      let resolution: string = '';
      switch (f.resolutionType) {
        case 'cmd':
          resolution = `Execute the following command:

\`\`\`sh
${f.resolution}
\`\`\`
`;
          break;
        case 'json':
        case 'js':
        case 'ts':
        case 'scss':
          resolution = `In file [${f.file}](${f.file}) update the code as follows:

\`\`\`${f.resolutionType}
${f.resolution}
\`\`\`
`;
          break;
      }

      findingsToReport.push(
        `### ${f.id} ${f.title} | ${f.severity}`, os.EOL,
        os.EOL,
        f.description, os.EOL,
        os.EOL,
        resolution,
        os.EOL,
        `File: [${f.file}${(f.position ? `:${f.position.line}:${f.position.character}` : '')}](${f.file})`, os.EOL,
        os.EOL
      );
    });

    const s: string[] = [
      `# Upgrade project ${path.posix.basename(this.projectRootPath as string)} to v${this.toVersion}`, os.EOL,
      os.EOL,
      `Date: ${(new Date().toLocaleDateString())}`, os.EOL,
      os.EOL,
      '## Findings', os.EOL,
      os.EOL,
      `Following is the list of steps required to upgrade your project to SharePoint Framework version ${this.toVersion}. [Summary](#Summary) of the modifications is included at the end of the report.`, os.EOL,
      os.EOL,
      findingsToReport.join(''),
      '## Summary', os.EOL,
      os.EOL,
      '### Execute script', os.EOL,
      os.EOL,
      '```sh', os.EOL,
      (reportData.packageManagerCommands
        .concat(reportData.commandsToExecute
          .filter((command) =>
            command.indexOf(this.getPackageManagerCommand('install')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('installDev')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('uninstall')) === -1 &&
            command.indexOf(this.getPackageManagerCommand('uninstallDev')) === -1))).join(os.EOL), os.EOL,
      '```', os.EOL,
      os.EOL,
      '### Modify files', os.EOL,
      os.EOL,
      Object.keys(reportData.modificationPerFile).map(file => {
        return [
          `#### [${file}](${file})`, os.EOL,
          os.EOL,
          reportData.modificationPerFile[file].map((m: ReportDataModification) => `${m.description}:${os.EOL}${os.EOL}\`\`\`${reportData.modificationTypePerFile[file]}${os.EOL}${m.modification}${os.EOL}\`\`\``).join(os.EOL + os.EOL), os.EOL,
        ].join('');
      }).join(os.EOL),
      os.EOL,
    ];

    return s.join('').trim();
  }

  private getReportData(findings: FindingToReport[]): ReportData {
    const commandsToExecute: string[] = [];
    const modificationPerFile: Dictionary<ReportDataModification[]> = {};
    const modificationTypePerFile: Hash = {};
    const packagesDevExact: string[] = [];
    const packagesDepExact: string[] = [];
    const packagesDepUn: string[] = [];
    const packagesDevUn: string[] = [];

    findings.forEach(f => {
      if (f.resolutionType === 'cmd') {
        if (f.resolution.indexOf('npm') > -1 ||
          f.resolution.indexOf('yarn') > -1) {
          this.mapPackageManagerCommand(f.resolution, packagesDevExact,
            packagesDepExact, packagesDepUn, packagesDevUn);
        }
        else {
          commandsToExecute.push(f.resolution);
        }
      }
      else {
        if (!modificationPerFile[f.file]) {
          modificationPerFile[f.file] = [];
        }
        if (!modificationTypePerFile[f.file]) {
          modificationTypePerFile[f.file] = f.resolutionType;
        }

        modificationPerFile[f.file].push({
          description: f.description,
          modification: f.resolution
        });
      }
    });

    const packageManagerCommands: string[] = this.reducePackageManagerCommand(
      packagesDepExact, packagesDevExact, packagesDepUn, packagesDevUn);

    return {
      commandsToExecute: commandsToExecute,
      packageManagerCommands: packageManagerCommands,
      modificationPerFile: modificationPerFile,
      modificationTypePerFile: modificationTypePerFile
    }
  }

  private mapPackageManagerCommand(command: string, packagesDevExact: string[],
    packagesDepExact: string[], packagesDepUn: string[], packagesDevUn: string[]): void {
    // matches must be in this particular order to avoid false matches, eg.
    // uninstallDev contains install
    if (command.startsWith(`${this.getPackageManagerCommand('uninstallDev')} `)) {
      packagesDevUn.push(command.replace(this.getPackageManagerCommand('uninstallDev'), '').trim());
      return;
    }
    if (command.startsWith(`${this.getPackageManagerCommand('installDev')} `)) {
      packagesDevExact.push(command.replace(this.getPackageManagerCommand('installDev'), '').trim());
      return;
    }
    if (command.startsWith(`${this.getPackageManagerCommand('uninstall')} `)) {
      packagesDepUn.push(command.replace(this.getPackageManagerCommand('uninstall'), '').trim());
      return;
    }
    if (command.startsWith(`${this.getPackageManagerCommand('install')} `)) {
      packagesDepExact.push(command.replace(this.getPackageManagerCommand('install'), '').trim());
    }
  }

  private reducePackageManagerCommand(packagesDepExact: string[], packagesDevExact: string[],
    packagesDepUn: string[], packagesDevUn: string[]): string[] {
    const commandsToExecute: string[] = [];

    if (packagesDepExact.length > 0) {
      commandsToExecute.push(`${this.getPackageManagerCommand('install')} ${packagesDepExact.join(' ')}`);
    }

    if (packagesDevExact.length > 0) {
      commandsToExecute.push(`${this.getPackageManagerCommand('installDev')} ${packagesDevExact.join(' ')}`);
    }

    if (packagesDepUn.length > 0) {
      commandsToExecute.push(`${this.getPackageManagerCommand('uninstall')} ${packagesDepUn.join(' ')}`);
    }

    if (packagesDevUn.length > 0) {
      commandsToExecute.push(`${this.getPackageManagerCommand('uninstallDev')} ${packagesDevUn.join(' ')}`);
    }

    return commandsToExecute;
  }

  private getPackageManagerCommand(command: string): string {
    return (SpfxProjectUpgradeCommand.packageCommands as any)[this.packageManager][command];
  }

  private getCopyCommand(command: string): string {
    return (SpfxProjectUpgradeCommand.copyCommands as any)[this.shell][command];
  }

  private getDirectoryCommand(command: string): string {
    return (SpfxProjectUpgradeCommand.createDirectoryCommands as any)[this.shell][command];
  }

  private getAddCommand(command: string): string {
    return (SpfxProjectUpgradeCommand.addFileCommands as any)[this.shell][command];
  }

  private getRemoveCommand(command: string): string {
    return (SpfxProjectUpgradeCommand.removeFileCommands as any)[this.shell][command];
  }

  private getProjectRoot(folderPath: string): string | null {
    const packageJsonPath: string = path.resolve(folderPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return folderPath;
    }
    else {
      const parentPath: string = path.resolve(folderPath, `..${path.sep}`);
      if (parentPath !== folderPath) {
        return this.getProjectRoot(parentPath);
      }
      else {
        return null;
      }
    }
  }

  private getProjectVersion(): string | undefined {
    const yoRcPath: string = path.resolve(this.projectRootPath as string, '.yo-rc.json');
    if (fs.existsSync(yoRcPath)) {
      try {
        const yoRc: any = JSON.parse(fs.readFileSync(yoRcPath, 'utf-8'));
        if (yoRc && yoRc['@microsoft/generator-sharepoint'] &&
          yoRc['@microsoft/generator-sharepoint'].version) {
          return yoRc['@microsoft/generator-sharepoint'].version;
        }
      }
      catch { }
    }

    const packageJsonPath: string = path.resolve(this.projectRootPath as string, 'package.json');
    try {
      const packageJson: any = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson &&
        packageJson.dependencies &&
        packageJson.dependencies['@microsoft/sp-core-library']) {
        const coreLibVersion: string = packageJson.dependencies['@microsoft/sp-core-library'];
        return coreLibVersion.replace(/[^0-9\.]/g, '');
      }
    }
    catch { }

    return undefined;
  }

  public options(): CommandOption[] {
    const options: CommandOption[] = [
      {
        option: '-v, --toVersion [toVersion]',
        description: 'The version of SharePoint Framework to which upgrade the project'
      },
      {
        option: '--packageManager [packageManager]',
        description: 'The package manager you use. Supported managers npm|pnpm|yarn. Default npm',
        autocomplete: ['npm', 'pnpm', 'yarn']
      },
      {
        option: '--shell [shell]',
        description: 'The shell you use. Supported shells bash|powershell|cmd. Default bash',
        autocomplete: ['bash', 'powershell', 'cmd']
      },
      {
        option: '-f, --outputFile [outputFile]',
        description: 'Path to the file where the upgrade report should be stored in'
      }
    ];

    const parentOptions: CommandOption[] = super.options();
    parentOptions.forEach(o => {
      if (o.option.indexOf('--output') > -1) {
        o.description = 'Output type. json|text|md. Default text';
        o.autocomplete = ['json', 'text', 'md'];
      }
    })
    return options.concat(parentOptions);
  }

  public validate(): CommandValidate {
    return (args: CommandArgs): boolean | string => {
      if (args.options.packageManager) {
        if (['npm', 'pnpm', 'yarn'].indexOf(args.options.packageManager) < 0) {
          return `${args.options.packageManager} is not a supported package manager. Supported package managers are npm, pnpm and yarn`;
        }
      }

      if (args.options.shell) {
        if (['bash', 'powershell', 'cmd'].indexOf(args.options.shell) < 0) {
          return `${args.options.shell} is not a supported shell. Supported shells are bash, powershell and cmd`;
        }
      }

      if (args.options.outputFile) {
        const dirPath: string = path.dirname(path.resolve(args.options.outputFile));
        if (!fs.existsSync(dirPath)) {
          return `Directory ${dirPath} doesn't exist. Please check the path and try again.`;
        }
      }

      return true;
    };
  }

  public commandHelp(args: any, log: (help: string) => void): void {
    const chalk = vorpal.chalk;
    log(vorpal.find(commands.PROJECT_UPGRADE).helpInformation());
    log(
      `   ${chalk.yellow('Important:')} Run this command in the folder where the project
    that you want to upgrade is located. This command doesn't change your
    project files.
      
  Remarks:

    The ${this.name} command helps you upgrade your SharePoint Framework
    project to the specified version. If no version is specified, the command
    will upgrade to the latest version of the SharePoint Framework it supports
    (v1.10.0).

    This command doesn't change your project files. Instead, it gives you
    a report with all steps necessary to upgrade your project to the specified
    version of the SharePoint Framework. Changing project files is error-prone,
    especially when it comes to updating your solution's code. This is why at
    this moment, this command produces a report that you can use yourself to
    perform the necessary updates and verify that everything is working as
    expected.

    Using this command you can upgrade SharePoint Framework projects built using
    versions: 1.0.0, 1.0.1, 1.0.2, 1.1.0, 1.1.1, 1.1.3, 1.2.0, 1.3.0, 1.3.1,
    1.3.2, 1.3.4, 1.4.0, 1.4.1, 1.5.0, 1.5.1, 1.6.0, 1.7.0, 1.7.1, 1.8.0,
    1.8.1, 1.8.2 and 1.9.1.

  Examples:
  
    Get instructions to upgrade the current SharePoint Framework project to
    SharePoint Framework version 1.5.0 and save the findings in a Markdown file
      ${this.name} --toVersion 1.5.0 --output md --outputFile upgrade-report.md

    Get instructions to Upgrade the current SharePoint Framework project to
    SharePoint Framework version 1.5.0 and show the summary of the findings
    in the shell
      ${this.name} --toVersion 1.5.0

    Get instructions to upgrade the current SharePoint Framework project to the
    latest SharePoint Framework version supported by the Office 365 CLI using
    pnpm
      ${this.name} --packageManager pnpm

    Get instructions to upgrade the current SharePoint Framework project to the
    latest SharePoint Framework version supported by the Office 365 CLI
      ${this.name}

    Get instructions to upgrade the current SharePoint Framework project to the
    latest SharePoint Framework version supported by the Office 365 CLI using
    PowerShell
      ${this.name} --shell powershell
`);
  }
}

module.exports = new SpfxProjectUpgradeCommand();