namespace ts.server.typingsInstaller {
    const fs: {
        appendFileSync(file: string, content: string): void
    } = require("fs");

    const path: {
        join(...parts: string[]): string;
        dirname(path: string): string;
        basename(path: string, extension?: string): string;
    } = require("path");

    class FileLog implements Log {
        constructor(private logFile: string | undefined) {
        }

        isEnabled = () => {
            return typeof this.logFile === "string";
        }
        writeLine = (text: string) => {
            if (typeof this.logFile !== "string") return;

            try {
                fs.appendFileSync(this.logFile, `[${nowString()}] ${text}${sys.newLine}`);
            }
            catch (e) {
                this.logFile = undefined;
            }
        }
    }

    /** Used if `--npmLocation` is not passed. */
    function getDefaultNPMLocation(processName: string) {
        if (path.basename(processName).indexOf("node") === 0) {
            return `"${path.join(path.dirname(process.argv[0]), "npm")}"`;
        }
        else {
            return "npm";
        }
    }

    interface TypesRegistryFile {
        entries: MapLike<MapLike<string>>;
    }

    function loadTypesRegistryFile(typesRegistryFilePath: string, host: InstallTypingHost, log: Log): Map<MapLike<string>> {
        if (!host.fileExists(typesRegistryFilePath)) {
            if (log.isEnabled()) {
                log.writeLine(`Types registry file '${typesRegistryFilePath}' does not exist`);
            }
            return createMap<MapLike<string>>();
        }
        try {
            const content = <TypesRegistryFile>JSON.parse(host.readFile(typesRegistryFilePath)!);
            return createMapFromTemplate(content.entries);
        }
        catch (e) {
            if (log.isEnabled()) {
                log.writeLine(`Error when loading types registry file '${typesRegistryFilePath}': ${(<Error>e).message}, ${(<Error>e).stack}`);
            }
            return createMap<MapLike<string>>();
        }
    }

    const typesRegistryPackageName = "types-registry";
    function getTypesRegistryFileLocation(globalTypingsCacheLocation: string): string {
        return combinePaths(normalizeSlashes(globalTypingsCacheLocation), `node_modules/${typesRegistryPackageName}/index.json`);
    }

    interface ExecSyncOptions {
        cwd: string;
        encoding: "utf-8";
    }
    type ExecFileSync = (file: string, args: string[], options: ExecSyncOptions) => string;

    export class NodeTypingsInstaller extends TypingsInstaller {
        private readonly nodeExecFileSync: ExecFileSync;
        private readonly npmPath: string;
        readonly typesRegistry: Map<MapLike<string>>;

        private delayedInitializationError: InitializationFailedResponse | undefined;

        constructor(globalTypingsCacheLocation: string, typingSafeListLocation: string, typesMapLocation: string, npmLocation: string | undefined, throttleLimit: number, log: Log) {
            super(
                sys,
                globalTypingsCacheLocation,
                typingSafeListLocation ? toPath(typingSafeListLocation, "", createGetCanonicalFileName(sys.useCaseSensitiveFileNames)) : toPath("typingSafeList.json", __dirname, createGetCanonicalFileName(sys.useCaseSensitiveFileNames)),
                typesMapLocation ? toPath(typesMapLocation, "", createGetCanonicalFileName(sys.useCaseSensitiveFileNames)) : toPath("typesMap.json", __dirname, createGetCanonicalFileName(sys.useCaseSensitiveFileNames)),
                throttleLimit,
                log);
            this.npmPath = npmLocation !== undefined ? npmLocation : getDefaultNPMLocation(process.argv[0]);

            // If the NPM path contains spaces and isn't wrapped in quotes, do so.
            if (stringContains(this.npmPath, " ") && this.npmPath[0] !== `"`) {
                this.npmPath = `"${this.npmPath}"`;
            }
            if (this.log.isEnabled()) {
                this.log.writeLine(`Process id: ${process.pid}`);
                this.log.writeLine(`NPM location: ${this.npmPath} (explicit '${Arguments.NpmLocation}' ${npmLocation === undefined ? "not " : ""} provided)`);
            }
            ({ execFileSync: this.nodeExecFileSync } = require("child_process"));

            this.ensurePackageDirectoryExists(globalTypingsCacheLocation);

            try {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Updating ${typesRegistryPackageName} npm package...`);
                }
                this.execFileSyncAndLog(this.npmPath, ["install", "--ignore-scripts", `${typesRegistryPackageName}@${this.latestDistTag}`], { cwd: globalTypingsCacheLocation });
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Updated ${typesRegistryPackageName} npm package`);
                }
            }
            catch (e) {
                if (this.log.isEnabled()) {
                    this.log.writeLine(`Error updating ${typesRegistryPackageName} package: ${(<Error>e).message}`);
                }
                // store error info to report it later when it is known that server is already listening to events from typings installer
                this.delayedInitializationError = {
                    kind: "event::initializationFailed",
                    message: (<Error>e).message
                };
            }

            this.typesRegistry = loadTypesRegistryFile(getTypesRegistryFileLocation(globalTypingsCacheLocation), this.installTypingHost, this.log);
        }

        listen() {
            process.on("message", (req: TypingInstallerRequestUnion) => {
                if (this.delayedInitializationError) {
                    // report initializationFailed error
                    this.sendResponse(this.delayedInitializationError);
                    this.delayedInitializationError = undefined;
                }
                switch (req.kind) {
                    case "discover":
                        this.install(req);
                        break;
                    case "closeProject":
                        this.closeProject(req);
                        break;
                    case "typesRegistry": {
                        const typesRegistry: { [key: string]: MapLike<string> } = {};
                        this.typesRegistry.forEach((value, key) => {
                            typesRegistry[key] = value;
                        });
                        const response: TypesRegistryResponse = { kind: EventTypesRegistry, typesRegistry };
                        this.sendResponse(response);
                        break;
                    }
                    case "installPackage": {
                        const { fileName, packageName, projectName, projectRootPath } = req;
                        const cwd = getDirectoryOfPackageJson(fileName, this.installTypingHost) || projectRootPath;
                        if (cwd) {
                            this.installWorker(-1, [packageName], cwd, success => {
                                const message = success ? `Package ${packageName} installed.` : `There was an error installing ${packageName}.`;
                                const response: PackageInstalledResponse = { kind: ActionPackageInstalled, projectName, success, message };
                                this.sendResponse(response);
                            });
                        }
                        else {
                            const response: PackageInstalledResponse = { kind: ActionPackageInstalled, projectName, success: false, message: "Could not determine a project root path." };
                            this.sendResponse(response);
                        }
                        break;
                    }
                    case "inspectValue": {
                        const response: InspectValueResponse = { kind: ActionValueInspected, result: inspectModule(req.options.fileNameToRequire) };
                        this.sendResponse(response);
                        break;
                    }
                    default:
                        Debug.assertNever(req);
                }
            });
        }

        protected sendResponse(response: TypingInstallerResponseUnion) {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Sending response:\n    ${JSON.stringify(response)}`);
            }
            process.send!(response); // TODO: GH#18217
            if (this.log.isEnabled()) {
                this.log.writeLine(`Response has been sent.`);
            }
        }

        protected installWorker(requestId: number, packageNames: string[], cwd: string, onRequestCompleted: RequestCompletedAction): void {
            if (this.log.isEnabled()) {
                this.log.writeLine(`#${requestId} with arguments'${JSON.stringify(packageNames)}'.`);
            }
            const start = Date.now();
            const hasError = installNpmPackages(this.npmPath, version, packageNames, (file, args) => this.execFileSyncAndLog(file, args, { cwd }));
            if (this.log.isEnabled()) {
                this.log.writeLine(`npm install #${requestId} took: ${Date.now() - start} ms`);
            }
            onRequestCompleted(!hasError);
        }

        /** Returns 'true' in case of error. */
        private execFileSyncAndLog(file: string, args: string[], options: Pick<ExecSyncOptions, "cwd">): boolean {
            if (this.log.isEnabled()) {
                this.log.writeLine(`Exec: ${file} ${args.join(" ")}`);
            }
            try {
                const stdout = this.nodeExecFileSync(file, args, { ...options, encoding: "utf-8" });
                if (this.log.isEnabled()) {
                    this.log.writeLine(`    Succeeded. stdout:${indent(sys.newLine, stdout)}`);
                }
                return false;
            }
            catch (error) {
                const { stdout, stderr } = error;
                this.log.writeLine(`    Failed. stdout:${indent(sys.newLine, stdout)}${sys.newLine}    stderr:${indent(sys.newLine, stderr)}`);
                return true;
            }
        }
    }

    function getDirectoryOfPackageJson(fileName: string, host: InstallTypingHost): string | undefined {
        return forEachAncestorDirectory(getDirectoryPath(fileName), directory => {
            if (host.fileExists(combinePaths(directory, "package.json"))) {
                return directory;
            }
        });
    }

    const logFilePath = findArgument(Arguments.LogFile);
    const globalTypingsCacheLocation = findArgument(Arguments.GlobalCacheLocation);
    const typingSafeListLocation = findArgument(Arguments.TypingSafeListLocation);
    const typesMapLocation = findArgument(Arguments.TypesMapLocation);
    const npmLocation = findArgument(Arguments.NpmLocation);

    const log = new FileLog(logFilePath);
    if (log.isEnabled()) {
        process.on("uncaughtException", (e: Error) => {
            log.writeLine(`Unhandled exception: ${e} at ${e.stack}`);
        });
    }
    process.on("disconnect", () => {
        if (log.isEnabled()) {
            log.writeLine(`Parent process has exited, shutting down...`);
        }
        process.exit(0);
    });
    const installer = new NodeTypingsInstaller(globalTypingsCacheLocation!, typingSafeListLocation!, typesMapLocation!, npmLocation, /*throttleLimit*/5, log); // TODO: GH#18217
    installer.listen();

    function indent(newline: string, str: string): string {
        return `${newline}    ` + str.replace(/\r?\n/, `${newline}    `);
    }
}
