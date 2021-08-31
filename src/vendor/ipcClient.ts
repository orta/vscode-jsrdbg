import ipc = require('node-ipc');
// import { Logger } from 'node-file-log';
import { timeout } from 'promised-timeout';
import { DebugSession, TerminatedEvent } from "vscode-debugadapter";
import { LocalPaths, LocalSourcesPattern } from './localSource';

ipc.config.appspace = 'vscode-janus-debug.';
ipc.config.id = 'debug_adapter';
ipc.config.retry = 1500;

import  { Logger } from "./logger";

const log = new Logger("DebugAdapterIPC");


/**
 * Acts as the client in our communication.
 *
 * @export
 * @class DebugAdapter
 */
export class DebugAdapterIPC {

    private serverSock: string = 'sock';

    public async connect(processId: number) {
        this.serverSock = 'sock' + processId.toString();
        log.debug(`connect to VS Code extension (${this.serverSock})`);
        const connWithTimeout = timeout({
            action: () => new Promise<void>((resolve) => {
                ipc.connectTo(this.serverSock, () => {

                    ipc.of[this.serverSock].on('connect', () => {
                        log.debug(`connected to VS Code extension`);
                        resolve();
                    });

                    ipc.of[this.serverSock].on('disconnect', () => {
                        log.debug(`disconnected from VS Code extension`);
                    });

                    ipc.of[this.serverSock].on('contextChosen', this.contextChosenDefault);
                    ipc.of[this.serverSock].on('urisFound', this.urisFoundDefault);
                    ipc.of[this.serverSock].on('type = "information"', this.displayMessageDefault);
                    ipc.of[this.serverSock].on('correctSourceFileProvided', this.askForCorrectSourceFileDefault);
                    ipc.of[this.serverSock].on('answerLaunchContexts', this.launchContextsDefault);
                    ipc.of[this.serverSock].on('scriptFinished', this.debugScriptDefault);
                });
            }),
            time: 6000,
            error: new Error('Request timed out')
        });
        await connWithTimeout;
    }

    public async disconnect(): Promise<void> {
        ipc.disconnect(this.serverSock);
    }

    public async showContextQuickPick(contextList: string[]): Promise<string> {
        return await this.ipcRequest<string>('showContextQuickPick', 'contextChosen', this.contextChosenDefault, (2 * 60 * 1000), contextList);
    }

    public async launchContexts(fileName: string): Promise<string> {
        return await this.ipcRequest<string>('launchContexts', 'answerLaunchContexts', this.launchContextsDefault, (2 * 60 * 1000), fileName);
    }

    public async findURIsInWorkspace(sourcePattern: LocalSourcesPattern): Promise<Map<string, LocalPaths>> {
        const result = await this.ipcRequest < [[string, LocalPaths]]>('findURIsInWorkspace', 'urisFound', this.urisFoundDefault, (5 * 60 * 1000), sourcePattern);
        const map = new Map(result);
        return map;
    }

    public async askForCorrectSourceFile(fileName: string, filePaths: string[], serverFileSourceCode?: string[]): Promise<string> {
        return await this.ipcRequest<string>(
            'askForCorrectSourceFile',
            'correctSourceFileProvided',
            this.askForCorrectSourceFileDefault,
            (5 * 60 * 1000),
            fileName,
            filePaths,
            serverFileSourceCode
        );
    }

    public async displayMessage(message: string, type = "information", source = ""): Promise<void> {
        ipc.of[this.serverSock].emit('displayMessage', {message, source, type});
    }

    public async debugScript(scriptName: string, session: DebugSession): Promise<void> {
        // do not await
        log.info(`debug script ${scriptName}`);
        this.ipcRequest<string>('debugScript', 'scriptFinished', this.debugScriptDefault, (2 * 60 * 1000), scriptName).then((value) => {
            log.info(`script ${scriptName} finished`);
            session.sendEvent(new TerminatedEvent());
        });
    }

    /**
     * You can provide an additional script "documents-to-json" as a portal script on the server
     * to convert documents specific objects to JSON so that the debugger can show more detailed informations
     * about the properties and members of the variables in the variable panel.
     */
    public async checkForAdditionalDebugJSONHelpers() {
        log.info(`checkForAdditionalDebugJSONHelpers`);
        await this.ipcRequest<string>(
            'checkForAdditionalDebugJSONHelpers',
            'checkForAdditionalDebugJSONHelpersResponse',
            this.checkForAdditionalDebugJSONHelpersDefault,
            (2 * 60 * 1000)
        );
    }

    private async ipcRequest<T>(requestEvent: string, responseEvent: string, responseDefault: (data: any) => void, requestTimeout: number, ...requestParameter: any[]): Promise<T> {
        log.debug(requestEvent);

        // replace default response handler temporarily
        let tmpHandler;
        ipc.of[this.serverSock].off(responseEvent, responseDefault);
        const reqWithTimeout = timeout({
            action: () => new Promise<T>(resolve => {
                ipc.of[this.serverSock].on(responseEvent, tmpHandler = (result: T) => {
                    resolve(result);
                });
            }),
            time: requestTimeout,
            error: new Error('Request timed out')
        });

        // call the request and finally reset default response handler
        let returnValue: T;
        ipc.of[this.serverSock].emit(requestEvent, requestParameter);
        try {
            returnValue = await reqWithTimeout;
        } finally {
            ipc.of[this.serverSock].off(responseEvent, tmpHandler);
            ipc.of[this.serverSock].on(responseEvent, responseDefault);
        }

        return returnValue;
    }

    private contextChosenDefault(data: any) {
        log.warn(`got 'contextChosen' message from VS Code extension but we haven't asked!`);
    }
    private launchContextsDefault(data: any) {
        log.warn(`got 'answerLaunchContexts' message from VS Code extension but we haven't asked!`);
    }
    private urisFoundDefault(data: any) {
        log.warn(`got 'urisFound' message from VS Code extension but we haven't asked!`);
    }
    private askForCorrectSourceFileDefault(data: any) {
        log.warn(`got 'correctSourceFileProvided' message from VS Code extension but we haven't asked!`);
    }
    private displayMessageDefault(data: any) {
        log.warn(`got 'displayMessage' message from VS Code extension but we haven't asked!`);
    }
    private debugScriptDefault(data: any) {
        log.warn(`got 'debugScript' message from VS Code extension but we haven't asked!`);
    }
    private checkForAdditionalDebugJSONHelpersDefault(data: any) {
        log.warn(`got 'checkForAdditionalDebugJSONHelpersResponse' message from VS Code extension but we haven't asked!`);
    }
}
