import * as fs from 'fs';
// import { Logger } from 'node-file-log';
import { parse } from 'path';



export interface LocalPaths {
    name: string;
    path: string;
    paths: string[];
}

export interface LocalSourcesPattern {
    include: string;
    exclude: string;
}


import  { Logger } from "./logger";

const localSourceLog = new Logger("SouceMap");


/**
 * A local source file.
 */
export class LocalSource {
    /** The name of this source. Usually a file name. */
    public readonly name: string;
    /** The local absolute path to this source. */
    public path?: string;
    public paths: string[];
    /** An array of possible alias names. */
    public aliasNames: string[];
    /** An artificial key that iff > 0 is used by VS Code to retrieve the source through the SourceRequest. */
    public sourceReference: number;

    constructor(pathsOrPath: string | string[]) {
        this.paths = [];

        const paths = (Array.isArray(pathsOrPath)) ? pathsOrPath : [pathsOrPath];
        if (paths.length === 0) {
            throw new Error("Local source must have at least one local path");
        } else if (paths.length === 1) {
            // The file exists only once in the workspace
            this.path = paths[0];
        } else {
            // There are multiple files with the same name in the workspace. We will save
            // all paths. Once the file is requested for debugging, we will ask the user
            // to provide the correct file
            this.paths = paths;
            localSourceLog.info(`Additional paths found ${JSON.stringify(this.paths)}`);
        }

        // we assume that all paths are pointing to the same file (name). We can use
        // the first path to get the file name
        const parsedPath = parse(paths[0]);
        this.name = parsedPath.base;
        this.aliasNames = [
            parsedPath.name,
            parsedPath.base
        ];
        this.sourceReference = 0;
    }

    public loadFromDisk(): string {
        if (this.path) {
            return fs.readFileSync(this.path, 'utf8');
        } else {
            throw new Error(`Can't load source ${this.name}. Found multiple source files with the same name`);
        }
    }

    public getSourceLine(lineNo: number): string {
        const fileContents = this.loadFromDisk();
        const lines = fileContents.split("\n");
        const ret = lines[lineNo - 1];
        if (ret === undefined) {
            throw new Error(`Line ${lineNo} does not exist in ${this.name}`);
        }
        return ret.trim();
    }

    public leadingDebuggerStmts(): number {
        let counter = 0;
        const fileContents = this.loadFromDisk();
        const lines = fileContents.split("\n");
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("debugger;")) {
                counter++;
            } else {
                break;
            }
        }
        return counter;
    }

    public sourceName(): string {
        return parse(this.name).name;
    }
}
