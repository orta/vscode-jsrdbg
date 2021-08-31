import * as assert from 'assert';
import { readFile, writeFileSync } from 'fs';

writeFileSync("/tmp/works", "OK");

import { existsSync, readFileSync } from 'fs';
import { sync as globSync } from "glob";
import { connect, Socket } from 'net';
import { connect as connectTLS } from "tls";
import * as path from 'path';
import stripJsonComments = require('strip-json-comments');
import { v4 as uuidV4 } from 'uuid';
import { ContinuedEvent, LoggingDebugSession, InitializedEvent, OutputEvent, StoppedEvent, TerminatedEvent } from 'vscode-debugadapter';
import { logger } from 'vscode-debugadapter/lib/logger';
import { DebugProtocol } from 'vscode-debugprotocol';
// TODO: remove this, it brings in a huge amount of unnessesary deps
import * as waitOn from "wait-on"
import { AttachRequestArguments, CommonArguments, LaunchRequestArguments } from './config';
import { DebugConnection } from './connection';
import { Context, ContextId } from './context';
import { FrameMap } from './frameMap';
import { DebugAdapterIPC } from './ipcClient';
import { LocalPaths, LocalSource } from './localSource';
import { Breakpoint, Command, Response, StackFrame, Variable, variableValueToString } from './protocol';
import { ServerSource, SourceMap } from './sourceMap'; 
import { VariablesContainer, VariablesMap } from './variablesMap';

// tslint:disable-next-line:no-var-requires
const utf8 = require('utf8');
import  { Logger } from "./logger";

const log = new Logger("Debug");

function codeToString(code: string): string {
    switch (code) {
        case 'ECANCELED':
            return 'Operation canceled';

        case 'ECONNABORTED':
            return 'Connection aborted';

        case 'ECONNREFUSED':
            return 'Connection refused';

        case 'ECONNRESET':
            return 'Connection reset';

        case 'ETIMEDOUT':
            return 'Connection timed out';

        default:
            return 'Unknown error';
    }
}

/**
 * Construct a user-facing string from given Error instance.
 *
 * Currently: Just capitalize first letter.
 * @param {Error} err The Error instance.
 * @returns A string suitable for displaying to the user.
 */
function toUserMessage(err: Error): string {
    const str = err.message;
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export class JanusDebugSession extends LoggingDebugSession {
    private connection: DebugConnection | undefined;
    private sourceMap: SourceMap;
    private frameMap: FrameMap;
    private variablesMap: VariablesMap;
    private config: 'launch' | 'attach' | undefined;
    private attachedContextId: number | undefined = undefined;
    private ipcClient: DebugAdapterIPC;
    private msgDebuggerCnt = 0;
    private msgLineCnt = 0;
    private msgSourceCnt = 0;
    private terminateOnDisconnect = false;
    private breakOnAttach = false;

    /**
     * Use JavaScript source maps (if they exist).
     */
    private useJavascriptSourceMaps: boolean = false;

    /**
     * Output directory of the generated source files (e. g. from typescript transpiler).
     * @todo This is a temporary solution. It should be possible to get this information from
     *       the tsconfig.json, babel configuration or whatever transpiler is used.
     */
    private javascriptSourceMapsOutDir: string = "";
    private workspacePath: string = "";


    public constructor() {
        super();
        this.connection = undefined;
        this.ipcClient = new DebugAdapterIPC();
        this.sourceMap = new SourceMap(this.ipcClient);
        this.frameMap = new FrameMap();
        this.variablesMap = new VariablesMap();
    }

    protected async logServerVersion() {
        log.debug("sending sever_version Request ...");
        if (this.connection) {
            await this.connection.sendRequest(new Command('server_version'), async (response: Response) => {
                log.info(`Determined version ${response.content.version ? response.content.version : undefined} of remote debugger`);
            });
        } else {
            log.error("Connection must not be undefined to log server version.");
            throw new Error("Connection must not be undefined to log server version.");
        }
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        log.info("initializeRequest");

        const body = {
            exceptionBreakpointFilters: [],
            supportsCompletionsRequest: false,
            supportsConditionalBreakpoints: false,
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: false,
            supportsFunctionBreakpoints: false,
            supportsGotoTargetsRequest: false,
            supportsHitConditionalBreakpoints: false,
            supportsRestartFrame: false,
            supportsSetVariable: false,
            supportsStepBack: false,
            supportsStepInTargetsRequest: false,
            supportsDelayedStackTraceLoading: false
        };
        response.body = body;
        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
        log.info(`disconnectRequest`);

        const connection = this.connection;
        if (!connection) {
            this.sendResponse(response);
            return;
        }

        const contexts = await connection.coordinator.getAllAvailableContexts();
        const existContext = contexts.find(context => (context.id === this.attachedContextId));
        if (existContext) {
            if (this.config === 'launch' || this.terminateOnDisconnect) {
                if (existContext.isStopped()) {
                    log.debug(`Terminating debuggee (${this.attachedContextId})`);
                } else {
                    log.warn(`Trying to terminate debuggee (${this.attachedContextId}) will fail, because it's not stopped`);
                }
                await connection.sendRequest(new Command('stop', this.attachedContextId));
            }
        } else if (this.attachedContextId) {
            log.debug(`Debuggee (${this.attachedContextId}) not running anymore`);
        }

        await connection.sendRequest(new Command('exit'));
        await connection.disconnect();

        this.attachedContextId = undefined;
        this.config = undefined;
        this.connection = undefined;
        this.sendResponse(response);
    }


    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void> {
        this.applyConfig(args);
        log.info(`launchRequest`);

        this.connection = undefined;
        this.sourceMap = new SourceMap(this.ipcClient);
        this.frameMap = new FrameMap();
        this.variablesMap = new VariablesMap();
        this.config = 'launch';

        log.debug(`my workspace: ${args.workspace}`);
        this.workspacePath = args.workspace;
        this.useJavascriptSourceMaps = typeof args.sourceMaps === "boolean" ? args.sourceMaps : true;
        if (this.useJavascriptSourceMaps) {
            this.javascriptSourceMapsOutDir = this.tryFindSourceMapsDir();
            if (!this.javascriptSourceMapsOutDir) {
                this.useJavascriptSourceMaps = false;
                log.info(`Disabled source map support because i could not find the output directory of your source maps`);
            }
        }

        const sdsPort: number = args.applicationPort || 10000;
        const debuggerPort = args.debuggerPort || 8089;
        const host: string = args.host || 'localhost';
        const username: string = args.username || '';
        const principal: string = args.principal || '';
        const password = "" //nodeDoc.getJanusPassword(args.password);
        const stopOnEntry = args.stopOnEntry;
        const trustedCas = args.trustedCaPaths ? args.trustedCaPaths.map(caPath => readFileSync(caPath, "utf8")) : undefined;

        try {
            await this.ipcClient.connect(args.processId);
            await this.ipcClient.checkForAdditionalDebugJSONHelpers();
        } catch (e) {
            log.error(`launchRequest failed: ${e}`);
            response.success = false;
            response.message = `Launch failed: ${e}`;
            this.sendResponse(response);
            return;
        }

        if (!args.script || typeof args.script !== 'string' || args.script.length === 0) {
            const message = `Missing required property 'script' in your launch configuration. We suggest to set the property value to '\${file}' if you wan't to start debugging the current opened script (see https://gitlab.otris.de/tools/vscode-janus-debug/-/wikis/Debugger/Troubleshooting#fixing-the-launch-request-in-launchjson-start-debugging-with-f5-or-via-the-play-icon-in-the-debugger-panel)."`;
            // ipc message and terminate works better when restart was called
            this.ipcClient.displayMessage(message, "warning");
            this.sendEvent(new TerminatedEvent());
            return;
        }
        const source = new LocalSource(args.script);
        this.sourceMap.addMapping(source, source.sourceName());
        const sourceUrl = source.sourceName();


        // try {
        //     const uris: Map<string, LocalPaths> = await this.ipcClient.findURIsInWorkspace(args.localSources);
        //     this.sourceMap.setLocalUrls(uris);
        // } catch (e) {
        //     log.error(`launchRequest failed: ${e}`);
        //     response.success = false;
        //     response.message = `Launch failed: ${e}`;
        //     this.sendResponse(response);
        //     return;
        // }

        const connectDebugger = async () => {

            let scriptStarted = false;
            // if debugger port is closed, no script has been started on server by now,
            // so we start the script here, this will cause the server to open the port
            let portOpen = await this.waitOnPort(host, debuggerPort, 500);
            if (!portOpen) {
                log.info(`port ${debuggerPort} not open, script ${sourceUrl} will be started, to open the port`);
                this.ipcClient.debugScript(sourceUrl, this);
                scriptStarted = true;
                // if debugger port still not opened, something is wrong
                portOpen = await this.waitOnPort(host, debuggerPort, 10000);
                if (!portOpen) {
                    response.success = false;
                    response.message = `Cannot launch remote script ${sourceUrl}, port ${host}:${debuggerPort} not open`;
                    this.sendResponse(response);
                    return;
                }
            }


            // now the port is open, connect to server
            if (this.connection) {
                log.warn("launchRequest: already made a connection to remote debugger");
            }
            const debuggerSocket = connect(debuggerPort, host);
            const connection = new DebugConnection(debuggerSocket);
            this.connection = connection;

            this.connection.on('contextPaused', (contextId: number) => {
                if (this.attachedContextId !== undefined && this.attachedContextId === contextId) {
                    // todo: this is not only called when breakpoint is set
                    // this is called every time, when the debugger stops...
                    // so also after next, step-in, step-out, ...
                    this.reportStopped('breakpoint', contextId);
                }
            });

            this.connection.on('error', (reason: string) => {
                log.error(`Error when connecting to remote debugger: ${reason}`);
                response.success = false;
                response.message = reason;
                this.sendResponse(response);
                this.connection = undefined;
                this.sendEvent(new TerminatedEvent());
            });

            debuggerSocket.on('connect', async () => {
                log.info(`connected to ${host}:${debuggerPort}`);

                let maxId = -1;
                if (!scriptStarted) {
                    // if script is not started yet
                    // check running scripts, get highest id
                    // and then start the script
                    const contextsBefore = await connection.coordinator.getAllAvailableContexts();
                    if (contextsBefore.length > 0) {
                        contextsBefore.sort((c1, c2) => (c1.id - c2.id));
                        maxId = contextsBefore[contextsBefore.length - 1].id;
                    }
                    this.ipcClient.debugScript(sourceUrl, this);
                }

                // now the script is started and it has an id > maxId
                // so we must wait until getAllAvailableContexts() returns that id
                let nameContexts: Context[] | undefined;
                let selectedContext: Context | undefined;
                for (let i = 1; i < 50; i++) {
                    const contexts = await connection.coordinator.getAllAvailableContexts();
                    nameContexts = contexts.filter(context => (context.name === sourceUrl));
                    nameContexts.sort((c1, c2) => (c1.id - c2.id));
                    const len = nameContexts.length;
                    if (len > 0 && nameContexts[len - 1].id > maxId && nameContexts[len - 1].isStopped()) {
                        selectedContext = nameContexts[len - 1];
                        break;
                    }
                    log.info(`no context with name ${sourceUrl} available yet, wait and try again...`);
                    await this.sleep(500);
                    await this.setImmediatePromise();
                }
                if (!selectedContext || !nameContexts || nameContexts.length === 0) {
                    response.success = false;
                    response.message = `Could not launch remote script: no script with name ${sourceUrl} found`;
                    this.sendResponse(response);
                    return;
                }
                if (nameContexts.length > 1) {
                    log.info(`available contexts with name ${sourceUrl}: ${nameContexts.length}`);
                    const answer = await this.ipcClient.launchContexts(nameContexts[0].name);
                    if (answer === "Terminate all") {
                        connection.sendRequest(new Command("stop"));
                        response.success = false;
                        response.message = "Terminated all paused scripts";
                        this.sendResponse(response);
                        return;
                    } else if (answer === "Cancel") {
                        response.success = true;
                        this.sendResponse(response);
                        return;
                    }
                }

                // script started on server, now get source code
                try {
                    const remoteSource = await connection.sendRequest(Command.getSource(selectedContext.name, selectedContext.id),
                        async (res: Response) => {
                            // log.info(`getSource response: ${JSON.stringify(res)}`);
                            if (res.type === 'error') {
                                if (res.content.hasOwnProperty('message')) {
                                    throw new Error(res.content.message);
                                } else {
                                    throw new Error('Unknown error');
                                }
                            }
                            return res.content.source;
                        }
                    );
                    // log.info(`retrieved server source: ${JSON.stringify(remoteSource.source)} id: ${remoteSource.id} script: ${remoteSource.script}`);
                    this.sourceMap.serverSource = ServerSource.fromSources(source.sourceName(), remoteSource, true);
                } catch (e) {
                    log.error(`Command.getSource failed ${e}`);
                    response.success = false;
                    response.message = `Could not get source code for remote script ${sourceUrl}: ${e}`;
                    this.sendResponse(response);
                    return;
                }

                // start debugging
                log.debug(`selected context '${selectedContext.name}' (${selectedContext.id})`);
                this.attachedContextId = selectedContext.id;
                this.sendEvent(new InitializedEvent());
                this.debugConsole(`Connected to remote debugger on ${host}:${debuggerPort}`);
                this.sendResponse(response);
            });

            debuggerSocket.on('close', (hadError: boolean) => {
                if (hadError) {
                    log.error(`remote closed the connection due to error`);
                } else {
                    log.info(`remote closed the connection`);
                }
                this.connection = undefined;
                this.sendEvent(new TerminatedEvent());
            });

            debuggerSocket.on('error', (err: any) => {
                log.error(`failed to connect to ${host}:${debuggerPort}: ${err.code}`);

                response.success = false;
                response.message = `Failed to connect to server: ${codeToString(err.code)}`;
                if (err.code === 'ETIMEDOUT') {
                    response.message += `. Maybe wrong port or host?`;
                }
                this.sendResponse(response);

                this.connection = undefined;
                this.sendEvent(new TerminatedEvent());
            });
        };

        // if (args.portal) {
        //     await connectDebugger();
        // } else {
        //     const sdsConnection2 = new sds.SDSConnection();
        //     sdsConnection2.TIMEOUT = args.timeout || 6000;

        //     let scriptSource: string;
        //     try {
        //         if (!source.path) {
        //             // We have multiple files with the same name in the workspace.
        //             // Aks the user for the right one
        //             const selectedPath = await this.ipcClient.askForCorrectSourceFile(source.name, source.paths);
        //             source.path = selectedPath;
        //         }

        //         scriptSource = source.loadFromDisk();
        //     } catch (err) {
        //         log.error(`launchRequest failed: loading source from script failed: ${err}`);
        //         response.success = false;
        //         response.message = `Could not load source from '${source.path}': ${toUserMessage(err)}`;
        //         this.sendResponse(response);
        //         return;
        //     }

        //     sdsConnection2.connect('vscode-janus-debug', host, sdsPort, args.tls, args.startTls, trustedCas).then((clientId) => {

        //         log.info(`SDS connection established, got client ID: ${clientId}`);
        //         return sdsConnection2.PDClass.changeUser(username, password);

        //     }).then(userId => {

        //         log.debug(`successfully changed user; new user id: ${userId}`);

        //         if (principal.length > 0) {
        //             return sdsConnection2.PDClass.changePrincipal(principal);
        //         }

        //     }).then(() => {

        //         // Quick & dirty pause immediately feature
        //         if (stopOnEntry) {
        //             scriptSource = 'debugger;\n' + scriptSource;
        //         }

        //         // fill identifier
        //         const scriptIdentifier: string | undefined = uuidV4();
        //         log.debug("launching script with identifier: " + scriptIdentifier);
        //         sdsConnection2.CustomOperations.runScriptOnServer(scriptSource).then(returnedString => {

        //             // Important: this block is reached after the script returned and the debug session has ended. So
        //             // the entire environment of this block might not even exist anymore!

        //             log.debug(`script returned '${returnedString}'`);
        //             this.debugConsole(returnedString);

        //         });

        //     }).then(() => {
        //         return new Promise(resolve => {
        //             setTimeout(resolve, 1500);
        //         });
        //     }).then(connectDebugger).catch(reason => {

        //         log.error(`launchRequest failed: ${reason}`);
        //         response.success = false;
        //         response.message = `Could not launch script: ${toUserMessage(reason)}.`;
        //         this.sendResponse(response);

        //     }).then(() => {

        //         log.debug(`done; disconnecting SDS connection`);
        //         sdsConnection2.disconnect();

        //     });
        // }
    }

    private tryFindSourceMapsDir(): string {
        const tsconfigPath = path.join(this.workspacePath, "tsconfig.json");
        if (existsSync(tsconfigPath)) {
            try {
                const tsConfig = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, { encoding: "utf-8" })));
                if (tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
                    // the user has specified a separate output directory for the transpiled files and the source map files
                    let outDir: string = tsConfig.compilerOptions.outDir;
                    if (outDir.startsWith("./")) {
                        outDir = outDir.substr(2);
                    }

                    outDir = path.join(this.workspacePath, outDir);
                    return outDir;
                } else {
                    // The default behavior of typescript is to place the source map file and the transpiled file at the same folder
                    // as the source file.
                    return this.workspacePath;
                }
            } catch (err) {
                // ignore errors
            }
        }

        return "";
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): Promise<void> {
        this.applyConfig(args);
        log.info(`attachRequest`);

        this.connection = undefined;
        this.sourceMap = new SourceMap(this.ipcClient);
        this.frameMap = new FrameMap();
        this.variablesMap = new VariablesMap();
        this.config = 'attach';
        this.terminateOnDisconnect = args.terminateOnDisconnect;
        this.breakOnAttach = args.breakOnAttach;
        this.workspacePath = args.workspace;
        this.useJavascriptSourceMaps = typeof args.sourceMaps === "boolean" ? args.sourceMaps : true;
        if (this.useJavascriptSourceMaps) {
            this.javascriptSourceMapsOutDir = this.tryFindSourceMapsDir();
            if (!this.javascriptSourceMapsOutDir) {
                this.useJavascriptSourceMaps = false;
                log.info(`Disabled source map support because i could not find the output directory of your source maps`);
            }
        }

        log.debug(`my workspace: ${args.workspace}`);
        log.debug(`javascriptSourceMapsOutDir: ${this.javascriptSourceMapsOutDir}`);

        // try {
        //     await this.ipcClient.connect(args.processId);
        //     await this.ipcClient.checkForAdditionalDebugJSONHelpers();
        //     const uris: Map<string, LocalPaths> = await this.ipcClient.findURIsInWorkspace(args.localSources);
        //     // log.debug(`found ${JSON.stringify(uris)} URIs in workspace`);
        //     this.sourceMap.setLocalUrls(uris);
        // } catch (e) {
        //     log.error(`attachRequest failed: ${e}`);
        //     response.success = false;
        //     response.message = `Attach failed: ${e}`;
        //     this.sendResponse(response);
        //     return;
        // }

        const port: number = args.debuggerPort || 8089;
        const host: string = args.host || 'localhost';
        const socket = connect(port, host);

        if (this.connection) {
            log.warn("attachRequest: already made a connection");
        }

        const connection = new DebugConnection(socket);
        this.connection = connection;

        this.connection.on('contextPaused', (contextId: number) => {
            if (this.attachedContextId !== undefined && this.attachedContextId === contextId) {
                // todo: this is not only called when breakpoint is set
                // this is called every time, when the debugger stops...
                // so also after next, step-in, step-out, ...
                this.reportStopped('breakpoint', contextId);
            }
        });

        this.connection.on('error', (reason: string) => {
            // TODO: duplicate on-error function
            log.error(`Error on connection: ${reason}`);
            response.success = false;
            response.message = reason;
            this.sendResponse(response);
            this.connection = undefined;
            this.sendEvent(new TerminatedEvent());
        });

        // this.logServerVersion();

        socket.on('connect', async () => {
            log.info(`connected to ${host}:${port}`);

            try {
                if (this.connection) {
                    const contexts: Context[] = await this.connection.coordinator.getAllAvailableContexts();

                    // sort contexts by ids meaning by starting time
                    // that might help the user when they must select one from list
                    contexts.sort((c1, c2) => (c1.id - c2.id));

                    // log.info(`available contexts: ${contexts.length}`);
                    if (contexts.length < 1) {
                        throw new Error("no context found to attach to");
                    } else {
                        let targetContext: Context;
                        if (contexts.length > 1) {
                            const contextNames = contexts.map(context => context.name);
                            const quickPickList = contextNames;
                            const terminateAll = "<Terminate all paused scripts>";
                            quickPickList.push(terminateAll);
                            const targetContextName = await this.ipcClient.showContextQuickPick(quickPickList);
                            if (targetContextName === terminateAll) {
                                connection.sendRequest(new Command("stop"));
                                response.success = false;
                                response.message = "Terminated all paused scripts";
                                this.sendResponse(response);
                                return;
                            }
                            // log.info(`got ${targetContextName} to attach to`);
                            let targetContexts = contexts.filter(context => context.name === targetContextName);
                            if (targetContexts.length > 1) {
                                // if more scripts with same name, also filter for state stopped
                                const tmpContexts = targetContexts.filter(context => context.isStopped());
                                if (tmpContexts.length > 0) {
                                    targetContexts = tmpContexts;
                                }
                            }
                            targetContext = targetContexts[0];
                        } else {
                            targetContext = contexts[0];
                        }
                        if (targetContext === undefined) {
                            throw new Error("no context selected to attach to");
                        }

                        log.debug(`selected context '${targetContext.name}' (${targetContext.id})`);
                        try {
                            /**
                             * Source code of the remote file
                             */
                            const sources: string[] = await connection.sendRequest(Command.getSource(targetContext.name, targetContext.id),
                                async (res: Response) => {
                                    // log.debug(`getSource response: ${JSON.stringify(res)}`);
                                    if (res.type === 'error') {
                                        if (res.content.hasOwnProperty('message')) {
                                            throw new Error(res.content.message);
                                        } else {
                                            throw new Error('Unknown error');
                                        }
                                    }
                                    return res.content.source;
                                });
                            // log.info(`retrieved server sources: ${JSON.stringify(sources)}`);
                            const localSource = await this.sourceMap.getSource(targetContext.name, sources);
                            this.sourceMap.serverSource = ServerSource.fromSources(targetContext.name, sources, false, localSource);

                        } catch (e) {
                            log.error(`Command.getSource failed: ${e}`);
                            throw new Error(e.message);
                        }

                        this.attachedContextId = targetContext.id;
                        // if the script is paused, we must notify VS Code to get the
                        // debugging information in the UI
                        if (targetContext.isStopped()) {
                            // todo: move this reportStopped to configurationDoneRequest
                            // this.reportStopped('pause', targetContext.id);
                        } else if (this.breakOnAttach && this.connection) {
                            // Due to a problem in VS Code, the user cannot use the pause button
                            // before the stoppedEvent was sent to VS Code.
                            // Sending the stoppedEvent is triggered by the response of the pause request.
                            log.info("sending 'pause' request to remote");
                            await this.connection.sendRequest(new Command('pause', this.attachedContextId));
                        } else {
                            log.warn(`context ${this.attachedContextId} not paused`);
                        }
                    }
                } else {
                    throw new Error(`not connected to a remote debugger`);
                }

            } catch (e) {
                log.error(`attachRequest failed: ${e}`);
                response.success = false;
                response.message = `Attach failed: ${e}`;
                this.sendResponse(response);
                return;
            }


            // Tell the frontend that we are ready to set breakpoints and so on. The frontend will end the
            // configuration sequence by calling 'configurationDone' request
            this.sendEvent(new InitializedEvent());
            this.debugConsole(`Connected to remote debugger on ${host}:${port}`);
            this.sendResponse(response);
        });

        socket.on('close', async (hadError: boolean) => {
            await this.ipcClient.disconnect();

            if (hadError) {
                log.error(`remote closed the connection due to error`);
            } else {
                log.info(`remote closed the connection`);
            }
            this.connection = undefined;
            this.sendEvent(new TerminatedEvent());
        });

        socket.on('error', async (err: any) => {
            // TODO: duplicate on-error function
            log.error(`failed to connect to ${host}:${port}: ${err.code}`);
            await this.ipcClient.disconnect();

            response.success = false;
            response.message = `Failed to connect to server: ${codeToString(err.code)}`;
            if (err.code === 'ETIMEDOUT') {
                response.message += `. Maybe wrong port or host?`;
            }
            this.sendResponse(response);

            this.connection = undefined;
            this.sendEvent(new TerminatedEvent());
        });
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const numberOfBreakpoints: number = args.breakpoints ? args.breakpoints.length : 0;
        log.info(`setBreakPointsRequest for ${numberOfBreakpoints} breakpoint(s)`);
        // log.info(`setBreakPointsRequest for ${numberOfBreakpoints} breakpoint(s): ${JSON.stringify(args)}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }
        const conn = this.connection;

        if (numberOfBreakpoints === 0) {
            // Empty array specified, clear all breakpoints for the source

            try {
                const deleteAllBreakpointsCommand = new Command('delete_all_breakpoints');
                await conn.sendRequest(deleteAllBreakpointsCommand, async (res: Response) => {
                    if (res.type === 'error') {
                        log.error(`delete_all_breakpoints failed with: '${res.content.message}'`);
                        throw new Error(`Target responded with error '${res.content.message}'`);
                    }
                });

                log.debug(`setBreakPointsRequest succeeded: cleared all breakpoints`);
                response.body = {
                    breakpoints: []
                };
                response.success = true;
                this.sendResponse(response);

            } catch (e) {

                log.error(`setBreakPointsRequest failed: ${e}`);
                response.success = false;
                response.message = `Could not clear breakpoint(s): ${e}`;
                this.sendResponse(response);
            }

            // Done
            return;
        }

        if (!args.breakpoints || !args.source.path) {
            log.debug(`setBreakPointsRequest failed: ${JSON.stringify(args)}`);
            response.success = false;
            response.message = `An internal error occurred`;
            this.sendResponse(response);
            return;
        }

        let remoteSourceUrl = "";
        if (this.attachedContextId !== undefined) {
            remoteSourceUrl = await this.connection.coordinator.getContext(this.attachedContextId).name;
        } else {
            remoteSourceUrl = this.sourceMap.getRemoteUrl(args.source.path);
        }
        // log.debug(`setBreakPointsRequest remoteSourceUrl: ${remoteSourceUrl}`);
        const actualBreakpoints: Array<Promise<Breakpoint>> = [];
        const sourceName = path.parse(args.source.path).name;
        args.breakpoints.forEach((async breakpoint => {
            try {
                const source = await this.sourceMap.getSource(sourceName) as LocalSource;
                const dynamicScript = this.sourceMap.getDynamicServerSource(path.basename(source.name, ".js"));
                const remoteLine = this.sourceMap.toRemoteLine({ source, line: breakpoint.line }, dynamicScript);
                const setBreakpointCommand = Command.setBreakpoint(dynamicScript ? dynamicScript.name : remoteSourceUrl, remoteLine, false, this.attachedContextId);

                actualBreakpoints.push(
                    conn.sendRequest(setBreakpointCommand, (res: Response): Promise<Breakpoint> => {
                        return new Promise<Breakpoint>((resolve, reject) => {
                            // When the debugger returns the message that the breakpoint can't be set,
                            // we won't reject but make the specific breakpoint unverified (pending = false).
                            if ((res.type === 'error' && res.content.message) && (res.content.message === 'Cannot set breakpoint at given line.')) {
                                log.info(`cannot set breakpoint at ${breakpoint.line} (remote ${remoteLine})`);
                                return resolve({
                                    line: remoteLine,
                                    pending: false,
                                } as Breakpoint);
                            }
                            // When the debugger returns an error without message, we'll reject the breakpoint.
                            // That results in a complete reject of every breakpoint.
                            if ((res.type === 'error') && res.content.message && (res.content.message !== 'Cannot set breakpoint at given line.')) {
                                reject(new Error(`Target responded with error '${res.content.message}'`));
                            } else {
                                // The debug engine tells us that the current breakpoint can set, so
                                // the breakpoint will verified in vscode.
                                res.content.pending = true;
                                // log.info(`set breakpoint at requested line ${remoteLine} response line ${res.content.line} local line ${breakpoint.line}`);
                                resolve(res.content);
                            }
                        });
                    }
                    ));
            } catch (err) {
                log.debug(`setBreakPointsRequest ${err}`);
            }
        }));

        Promise.all(actualBreakpoints).then(async (res: Breakpoint[]) => {
            const breakpoints: DebugProtocol.Breakpoint[] = await Promise.all(res.map(async actualBreakpoint => {
                const localPos = await this.sourceMap.toLocalPosition(actualBreakpoint.line, remoteSourceUrl);
                const localSource = await this.sourceMap.getSource(localPos.source);
                return {
                    id: actualBreakpoint.bid,
                    line: localPos.line,
                    source: {
                        path: localSource ? localSource.name : "",
                    },

                    // According to the pre calculated value of pending the
                    // breakpoint is set to verified or to unverified.
                    verified: actualBreakpoint.pending,
                    // If the current breakpoint is unverified, we like to give a little hint.
                    message: actualBreakpoint.pending ? '' : 'Cannot set breakpoint at this line'

                };
            }));
            // log.debug(`setBreakPointsRequest succeeded: ${JSON.stringify(breakpoints)}`);
            response.body = {
                breakpoints,
            };
            this.sendResponse(response);
        }).catch(reason => {
            log.error(`setBreakPointsRequest failed: ${reason}`);
            response.success = false;
            response.message = `Could not set breakpoint(s): ${reason}`;
            this.sendResponse(response);
        });
    }

    protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
        log.info("setFunctionBreakPointsRequest");
        this.sendResponse(response);
    }

    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
        log.info("setExceptionBreakPointsRequest");
        this.sendResponse(response);
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
        log.info("configurationDoneRequest");

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        // we only consider the attached context for now
        if (this.attachedContextId !== undefined && this.attachedContextId >= 0) {

            if (this.sourceMap.serverSource.hiddenStatement) {
                // if the server source contains the internal "debugger;" statement, execute single step,
                // stopped event will be sent after script has been stopped
                log.debug(`preceding 'debugger;' statement -> sending 'next' to remote`);
                await this.connection.sendRequest(new Command('next', this.attachedContextId));
            } else {
                log.info("no preceding 'debugger;' statement -> check if context is paused");
                if (this.connection.coordinator.getContext(this.attachedContextId).isStopped()) {
                    this.reportStopped('pause', this.attachedContextId);
                }
            }
        } else {
            log.info("no attached context");
        }

        this.connection.on('newContext', (contextId: number, contextName: string, stopped: boolean) => {
            log.info(`new context on target: ${contextId}, context name: "${contextName}", stopped: ${stopped}`);
        });

        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        log.info(`continueRequest`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        const contextId: ContextId = args.threadId || 0;
        let context: Context;
        try {
            context = this.connection.coordinator.getContext(contextId);
        } catch (e) {
            log.warn(`continueRequest getContext: ${e}`);
            if (e.message.startsWith('No such context')) {
                this.connection.sendRequest(new Command('exit'));
            }
            return;
        }

        context.continue().then(() => {
            // log.debug('continueRequest succeeded');

            const continuedEvent = new ContinuedEvent(context.id);
            this.sendEvent(continuedEvent);
            this.sendResponse(response);
        }, err => {
            log.error('continueRequest failed: ' + err);
            response.success = false;
            response.message = err.toString();
            this.sendResponse(response);
        });
    }

    /**
     * When 'next' is executed, the debugger stops and sends a stop response.
     * This triggeres 'this.connection.on('contextPaused')' where reportStopped() is called.
     * reportStopped() tells vscode that the debugger has stopped.
     * After vscode gets the stopped event, it calls some functions like getStacktrace, getScope, etc.
     * See last section in this documentation for further information:
     * https://code.visualstudio.com/docs/extensionAPI/api-debugging#_the-debug-adapter-protocol-in-a-nutshell
     */
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        log.info(`nextRequest for threadId: ${args.threadId}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        const contextId: ContextId = args.threadId || 0;

        let context: Context;
        try {
            context = this.connection.coordinator.getContext(contextId);
        } catch (e) {
            log.warn(`nextRequest getContext: ${e}`);
            if (e.message.startsWith('No such context')) {
                this.connection.sendRequest(new Command('exit'));
            }
            return;
        }

        context.next().then(() => {
            // log.debug('nextRequest succeeded');
            response.success = true;
            this.sendResponse(response);
            // reportStopped is called in this.connection.on('contextPaused'),
            // that is when debugger has really stopped
            // this.reportStopped('step', contextId);
        }, err => {
            log.error('nextRequest failed: ' + err);
            response.success = false;
            response.message = err.toString();
            this.sendResponse(response);
        });
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        log.info(`stepInRequest`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        const contextId: ContextId = args.threadId || 0;
        const context = this.connection.coordinator.getContext(contextId);

        try {
            // We have to step in twice to get the correct stack frame
            await context.stepIn();
            // log.debug('first stepInRequest succeeded');
            response.success = true;
            this.sendResponse(response);
            // todo: see 'next'
            // this.reportStopped('step in', contextId);
        } catch (err) {
            log.error('stepInRequest failed: ' + err);
            response.success = false;
            response.message = err.toString();
            this.sendResponse(response);
        }
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        log.info(`stepOutRequest for threadId: ${args.threadId}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        const contextId: ContextId = args.threadId || 0;
        const context = this.connection.coordinator.getContext(contextId);

        try {
            await context.stepOut();
            // log.debug('first stepOutRequest succeeded');
            response.success = true;
            this.sendResponse(response);
            // todo: debugger does not send stop event on step out,
            // this means that the debugger has not stopped after the step out request,
            // so we cannot call reportStopped here, because it's simply not true
            // this.reportStopped('step out', contextId);
        } catch (err) {
            log.error('stepOutRequest failed: ' + err);
            response.success = false;
            response.message = err.toString();
            this.sendResponse(response);
        }
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
        log.info("stepBackRequest");
    }

    protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments): void {
        log.info("restartFrameRequest");
    }

    protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
        log.info("gotoRequest");
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        log.info(`pauseRequest`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        try {
            const contextId: ContextId = args.threadId || 0;

            const context = this.connection.coordinator.getContext(contextId);
            context.pause().then(() => {
                // log.debug('pauseRequest succeeded');
                response.success = true;
                this.sendResponse(response);
                // in context.pause() the stopped notification is catched
                // by another handler, so connection.handleResponse
                // does not send the stopped report to vs code also the
                // pause handler does not send it
                // note:
                // do not move reportStopped to the pause-handler for now
                // because we want to keep a chance to NOT notify vs code
                // (but not sure yet, if this will really be required...)
                this.reportStopped('pause', contextId);
            }).catch(reason => {
                log.error('pauseRequest failed: ' + reason);
                response.success = false;
                response.message = reason.toString();
                this.sendResponse(response);
            });

        } catch (err) {
            log.error(`Cannot pause context: ${err}`);
            response.success = false;
            response.message = err.toString();
            this.sendResponse(response);
        }
    }

    protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): Promise<void> {


        if (args.sourceReference === undefined) {
            log.info('sourceRequest');
            log.warn('args.sourceReference is undefined');
            this.sendResponse(response);
            return;
        }

        log.info(`sourceRequest for sourceReference ${args.sourceReference}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        response.body = {
            content: this.sourceMap.serverSource.getSourceCode(),
            mimeType: 'text/javascript'
        };

        this.sendResponse(response);
    }

    /**
     * Only return the attached context id here, we attached to only one
     * context in attach or launch.
     */
    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        log.info(`threadsRequest`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        response.body = {
            threads: [],
        };

        if (this.attachedContextId !== undefined) {

            let attachedContext: Context;
            try {
                attachedContext = this.connection.coordinator.getContext(this.attachedContextId);
            } catch (e) {
                log.warn(`threadsRequest getContext: ${e}`);
                if (e.message.startsWith('No such context')) {
                    // see description in stackTraceRequest()
                    this.connection.sendRequest(new Command('exit'));
                }
                return;
            }
            response.body.threads.push({
                id: this.attachedContextId,
                name: attachedContext.name
            });
        }
        // log.debug(`threadsRequest succeeded with ${JSON.stringify(response.body.threads)}`);
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        log.info(`stackTraceRequest`);
        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        // get the context
        const contextId: ContextId = args.threadId || 0;
        let context: Context;
        try {
            context = this.connection.coordinator.getContext(contextId);
            if (context.name.length === 0) {
                log.error(`Found context with id ${contextId}, but it has no name`);
            }
        } catch (e) {
            log.warn(`stackTraceRequest getContext: ${e}`);
            if (e.message.startsWith('No such context')) {
                this.connection.sendRequest(new Command('exit'));
            }
            return;
        }


        let trace: StackFrame[];
        try {
            trace = await context.getStacktrace();
        } catch (reason) {
            log.debug(`stackTraceRequest failed: ${reason}`);
            response.success = false;
            this.sendResponse(response);
            return;
        }
        const frames = this.frameMap.addFrames(contextId, trace);
        if (frames.length > 0 && frames.length < trace.length) {
            const logServerLine = this.sourceMap.serverSource.getSourceLine(frames[0].sourceLine);
            log.debug(`server line: '${logServerLine}'`);
        }

        const stackFrames: Array<Promise<DebugProtocol.StackFrame>> = frames.map(async (frame, index) => {
            if (this.connection === undefined) {
                throw new Error('No connection');
            }
            const result: DebugProtocol.StackFrame = { column: 0, id: frame.frameId, name: context.name, line: 0 };

            let localSource;
            try {
                log.debug(`index: ${index}, context '${context.name}' frame: url '${frame.sourceUrl}' line ${frame.sourceLine}`);

                // todo: get all required scripts in setBreakPointsRequest()
                // const urls = await this.connection.sendRequest(new Command('get_all_source_urls'), async (res: Response) => res.content.urls);
                // log.debug(`all urls ${JSON.stringify(urls)}`);

                // if script is required, make sure, that source is available in source map
                if ((frame.sourceUrl !== context.name) && (!this.sourceMap.getDynamicServerSource(frame.sourceUrl))) {
                    const dynamicSource = await this.connection.sendRequest(Command.getSource(frame.sourceUrl, this.attachedContextId), async (res: Response) => res.content.source);
                    log.info(`retrieved dynamic server source for: ${frame.sourceUrl}`);
                    const serverSource = ServerSource.fromSources(frame.sourceUrl, dynamicSource);
                    this.sourceMap.addDynamicScript(frame.sourceUrl, serverSource);
                }

                const localPos = await this.sourceMap.toLocalPosition(frame.sourceLine, frame.sourceUrl);
                localSource = await this.sourceMap.getSource(localPos.source);
                if (!localSource) {
                    // getSource() also called in toLocalPosition()
                    throw new Error("Unexpected error");
                }

                // local source found
                log.info(`position: line ${localPos.line} in file '${localPos.source}'`);
                result.line = localPos.line;
                result.name = localSource.name;
                result.source = {
                    presentationHint: 'emphasize',
                    path: localSource.path,
                    sourceReference: localSource.sourceReference
                };

                if (result.source && result.source.path && this.useJavascriptSourceMaps) {
                    // Source maps activated in launch / attach configuration. If source maps found,
                    // try to get the original position from source maps.
                    log.info("Try to map source position with sourceMaps.");
                    await this.applySourceMaps(localSource, result);
                } else {
                    log.info("Option 'sourceMaps' is deactivated.");
                }

            } catch (e) {
                if (localSource) {
                    result.line = this.sourceMap.prevLine;
                    result.name = localSource.name;
                    result.source = {
                        presentationHint: 'normal',
                        path: localSource.path,
                        sourceReference: localSource.sourceReference,
                    };
                } else {
                    result.line = 0;
                    result.name = `not available`;
                    result.source = undefined;
                }

                if (index === 0) {
                    log.error(`no local position for '${context.name}': ${e.message ? e.message : e}`);
                } else {
                    log.info(`Stacktrace: no local position for '${context.name}': ${e.message ? e.message : e}`);
                }

                if (index === 0) {
                    if (e.message && e.message.indexOf("debugger;") >= 0) {
                        if (this.msgDebuggerCnt < 1) {
                            this.ipcClient.displayMessage(e.message, "information");
                            this.msgDebuggerCnt++;
                        }
                    } else if (this.sourceMap.prevChunk.length > 0) {
                        if (this.msgLineCnt < 1) {
                            this.ipcClient.displayMessage("Line mismatch: see current lines in temporary file", "information", this.sourceMap.prevChunk);
                            this.msgLineCnt++;
                        }
                    } else {
                        if (this.msgSourceCnt < 1) {
                            this.ipcClient.displayMessage("Source mismatch: use Breakpoints and Continue.", "information", this.sourceMap.prevChunk);
                            this.msgSourceCnt++;
                        }
                    }
                }
            }

            return result;
        });

        Promise.all(stackFrames).then(result => {
            // return the stack frames to vscode
            response.body = {
                stackFrames: result,
                // totalFrames: trace.length,
            };
            // log.debug(`stackTraceRequest succeeded response.body: ${JSON.stringify(response.body)}`);
            response.success = true;
            this.sendResponse(response);
        });
    }

    /**
     * Tries to find a source map for the passed stackFrame. If found, it will overrides the source and position
     * information in the passed stackframe.
     * @note This function should probably be implemented in sourceMaps.ts::getLocalPosition
     * @param localSource
     * @param stackFrame
     */
    private async applySourceMaps(localSource: LocalSource, stackFrame: DebugProtocol.StackFrame) {
        if (!this.javascriptSourceMapsOutDir) {
            logger.warn("Tried to apply source maps, but configuration property 'sourceMapsOutDir' is missing. Please not that source maps can only be applied if you provide the path to the output directory.");
        } else if (stackFrame.source && stackFrame.source.path && localSource.path) {
            // Find the source map file. Every generated source has a comment at the end of the
            // file with the name of it's source map file
            const sourceCode = localSource.loadFromDisk();
            const sourceMapUrlMatches = sourceCode.match(/\/\/# sourceMappingURL=(.+)/);
            if (sourceMapUrlMatches) {
                // The match contains the file name of the generated source map. Now we have to find it in the
                // folder which contains the generated files (note: there seems to exists a module `source-map-resolve`
                // but in my first test this module joined relative paths to the wrong partition...)
                const sourceMapUrl = sourceMapUrlMatches[1];
                const pattern = path.join(this.javascriptSourceMapsOutDir, "**", sourceMapUrl);
                const sourceMapPaths = globSync(pattern);
                log.info(`Found the following source map files with pattern ${pattern}: ${JSON.stringify(sourceMapPaths)}`);
                if (sourceMapPaths.length === 1) {
                    const sourceMapPath = sourceMapPaths[0];
                    const rawSourceMap = JSON.parse(readFileSync(sourceMapPath).toString());
                    await require("source-map").SourceMapConsumer.with(rawSourceMap, null, async (consumer: any) => {
                        // jsrdbg does not provide us the column number, which is neccessary for `source-map` to resolve
                        // the original position. We just iterate over the source map until we get a result.
                        // It's ugly, but it seems to work...
                        let originalPosition;
                        let column = 0;
                        do {
                            originalPosition = consumer.originalPositionFor({
                                line: stackFrame.line,
                                column: column++
                            });
                        } while (originalPosition.source === null && column < 200);

                        if (typeof originalPosition.line === "number" && stackFrame.source) {
                            // We got a result. Replace source informations with the original position
                            // originalSourceUrl === relative path to the original source starting from the source map file
                            // (just take a look in a source map file for better understanding).
                            const originalSourceUrl = consumer.sources[0]; // @todo: Can contain more than one file if they got bundled...
                            stackFrame.source.path = path.normalize(
                                path.join(path.dirname(stackFrame.source.path as string), originalSourceUrl)
                            );

                            stackFrame.line = originalPosition.line;
                        } else {
                            log.info(`applySourceMaps(): No original source position found for ${stackFrame.source?.path} with line ${stackFrame.line}`);
                        }
                    });
                }
            } else {
                log.info(`No source map comment found in ${localSource.name}, source mapping not possible.`);
            }
        }
    }

    /**
     * See: https://code.visualstudio.com/docs/extensionAPI/api-debugging#_the-debug-adapter-protocol-in-a-nutshell
     */
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        log.info(`scopesRequest`);

        if (this.connection === undefined) {
            throw new Error('Internal error: No connection');
        }
        const frame = this.frameMap.getStackFrame(args.frameId);
        const contextId: ContextId = frame.contextId;
        const context = this.connection.coordinator.getContext(contextId);

        // The variablesReference is just the frameId because we do not keep track of individual scopes in a frame.
        // vscode only calls variablesRequest() when variablesReference > 0, the frame ids start with 0, so add 1.
        // We use the frameId, because the variableReference must be different for each scope
        // the frameId itself is not used in variablesMap
        const frameRef = frame.frameId + 1;

        // Update variablesMap
        context.getVariables().then(async (locals: Variable[]) => {
            // log.info(`updating variables map for ${locals.length} variables`);

            await this.variablesMap.createVariable("context", {}, contextId, context, frameRef);
            // 1. use await with createVariable()! because createVariable cannot be called parallel
            // 2. use for...of instead of forEach because forEach does not wait!
            for (const variable of locals) {
                await this.variablesMap.createVariable(variable.name, variable.value, contextId, context, frameRef);
            }

            const scopes: DebugProtocol.Scope[] = [{
                expensive: false,
                name: 'Locals',
                variablesReference: frameRef,
            }];
            response.body = {
                scopes,
            };
            response.success = true;
            // log.info(`scopesRequest succeeded`);
            this.sendResponse(response);
        }).catch(reason => {
            log.error(`could not update variablesMap: ${reason}`);
            response.success = false;
            log.info(`scopesRequest failed`);
            this.sendResponse(response);
        });
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        log.info(`variablesRequest ${args.variablesReference}`);
        if (this.connection === undefined) {
            throw new Error('Internal error: No connection');
        }

        try {
            // Get variables from the variables map
            let variablesContainer = this.variablesMap.getVariables(args.variablesReference);
            // variablesContainer.variables.forEach((variable) => {
            //     log.info(`variable: ${JSON.stringify(variable)}`);
            // });
            const context = this.connection.coordinator.getContext(variablesContainer.contextId);
            if (variablesContainer.parentId !== undefined && variablesContainer.variableName !== undefined) {
                // this conainer belongs to an object and we have to add the object members
                await this.variablesMap.addObjectMembers(context, variablesContainer);
            }

            // Check if the returned variables container contains a object variable that is collapsed.
            // If so, we have to request the debugger to evaluate this variable.
            const collapsedVariables = variablesContainer.variables.filter((variable) => {
                return variable.name === '___jsrdbg_collapsed___';
            });

            if (collapsedVariables.length > 0) {
                // We have some collapsed variables => send a evaluation request to the debugger

                for (const collapsedVariable of collapsedVariables) {
                    if (typeof collapsedVariable.evaluateName === 'undefined' || collapsedVariable.evaluateName === '') {
                        throw new Error(`Internal error: The variable "${collapsedVariable.name}" has no evaluate name.`);
                    }

                    // Request the variable and insert it to the variables map
                    const evaluateName = collapsedVariable.evaluateName.replace(".___jsrdbg_collapsed___", "");
                    const variable = await this.variablesMap.evaluateObject(context, evaluateName);
                    await this.variablesMap.createVariable(
                        evaluateName.substr(evaluateName.lastIndexOf('.')),
                        JSON.parse(variable.value),
                        variablesContainer.contextId,
                        context,
                        args.variablesReference,
                        evaluateName
                    );

                    // In the variables container we fetched before is now the collapsed variable and the new variable, so we have to
                    // re-fetch the variables container
                    variablesContainer = this.variablesMap.getVariables(args.variablesReference);

                    // Inside our variables container are not the variables we received from the debugger when we called the
                    // evaluate command, but a single variable (and of course the collapsed one) that refers to the variables container
                    // we want. This is because of the "variablesMap.createVariable()"-command. This command recreated the variable
                    // we requested for, but with a new variables container. We have to replace our existing variables container with that one.
                    variablesContainer = this.variablesMap.getVariables(variablesContainer.variables[1].variablesReference);
                    this.variablesMap.setVariables(args.variablesReference, variablesContainer);
                }
            }

            response.success = true;
            response.body = {
                variables: variablesContainer.variables
            };
            // log.debug(`variablesRequest succeeded`);

        } catch (e) {
            log.error(`variablesRequest failed: ${e}`);
            response.success = false;
            response.message = e.message;
        }

        this.sendResponse(response);
    }

    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
        log.info(`setVariableRequest with variablesRequest ${args.variablesReference}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        // Get the variable which we want to set from the variables map
        const variablesContainer: VariablesContainer = this.variablesMap.getVariables(args.variablesReference);
        const variables = variablesContainer.variables.filter((variable) => {
            return variable.name === args.name;
        });

        if (variables.length < 1) {
            throw new Error(`Internal error: No variable found with variablesReference ${args.variablesReference} and name ${args.name}`);
        } else if (variables.length > 1) {
            throw new Error(`Internal error: Multiple variables found with variablesReference ${args.variablesReference} and name ${args.name}`);
        }

        // VS-Code will always return string-values, even if the variable is not a string. For this reason we have to cast the value to the
        // correct type. Because we can only change primitive types it's pretty easy
        let variableValue: any = args.value;

        if (variableValue === 'null') {
            variableValue = null;
        } else if (variableValue === 'undefined') {
            variableValue = undefined;
        } else if (/[0-9]+/.test(variableValue)) {
            variableValue = parseInt(variableValue, 10);
        } else if (variableValue === 'true') {
            variableValue = true;
        } else if (variableValue === 'false') {
            variableValue = false;
        }

        const variable: DebugProtocol.Variable = variables[0];
        if (typeof variable.evaluateName === 'undefined' || variable.evaluateName === '') {
            throw new Error(`Internal error: Variable ${variable.name} has no evaluate name.`);
        }

        const context = this.connection.coordinator.getContext(variablesContainer.contextId);
        context.setVariable(variable.evaluateName, variableValue).then(() => {
            // Everything fine. Replace the variable in the variables map
            variable.value = args.value;
            const index = variablesContainer.variables.indexOf(variables[0]);
            variablesContainer.variables[index] = variable;
            this.variablesMap.setVariables(args.variablesReference, variablesContainer);

            response.body = variable;
            this.sendResponse(response);
        }).catch((reason) => {
            log.error(`setVariableRequest failed: ${reason}`);
            response.success = false;
            response.message = `Could not set variable "${args.name}": ${reason}`;
            this.sendResponse(response);
        });
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        // log.info(`evaluateRequest for ${args.expression}`);

        if (this.connection === undefined) {
            throw new Error('No connection');
        }

        if (args.frameId === undefined) {
            throw new Error('No frame id passed.');
        }

        const frame = this.frameMap.getStackFrame(args.frameId);
        const context = this.connection.coordinator.getContext(frame.contextId);
        context.evaluate(args.expression).then((variable: Variable) => {
            let utf8String;
            if (variable.type === "string") {
                utf8String = utf8.decode(variable.value);
            }
            response.body = {
                result: utf8String ? utf8String : variable.value,
                type: variable.type,
                variablesReference: 0,
            };
            this.sendResponse(response);
        }).catch((reason) => {
            response.success = false;
            response.message = `Could not evaluate expression "${args.expression}": ${reason}`;
            this.sendResponse(response);
        });
    }

    protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments): void {
        log.info(`stepInTargetsRequest`);
    }

    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
        log.info(`gotoTargetsRequest`);
    }

    protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
        log.info(`completionsRequest`);
    }

    /**
     * Apply given config.
     *
     * Currently, only configures the file logger.
     */
    private applyConfig(args: CommonArguments): void {
        // if (args.log) {
            Logger.config = { fileName: "/tmp/vscode-jsrdbg" };
        // }
        // log.info(`readConfig: ${JSON.stringify(args)}`);
    }

    /**
     * Print a message in the Debug Console window.
     */
    private debugConsole(message: string): void {
        this.sendEvent(new OutputEvent(message + '\n', 'console'));
    }

    private reportStopped(reason: string, contextId: number): void {
        log.debug(`sending 'stopped' to VS Code`);
        this.sendEvent(new StoppedEvent(reason, contextId));
    }

    private sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private setImmediatePromise() {
        return new Promise<void>((resolve) => {
            setImmediate(() => resolve());
        });
    }

    private async waitOnPort(host: string, debuggerPort: number, timeout: number): Promise<boolean> {
        return new Promise<boolean>(async (resolve) => {
            try {
                await waitOn({ resources: [`tcp:${host}:${debuggerPort}`], interval: 100, timeout });
            } catch (err) {
                return resolve(false);
            }
            return resolve(true);
        });
    }
}

console.log("Starting")
LoggingDebugSession.run(JanusDebugSession);
