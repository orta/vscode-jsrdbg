// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vscode-jsrdbg" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('vscode-jsrdbg.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from vscode-jsrdbg!');
	});

	context.subscriptions.push(disposable);



	
    // Upload and Debug script
    // context.subscriptions.push(
    //     vscode.commands.registerCommand('extension.jsrdbg.debugScript', async () => {

    //         const editor = vscode.window.activeTextEditor;
    //         let active: vscode.TextDocument;
    //         if (!editor || (editor.document.languageId !== "javascript" && editor.document.languageId !== "typescript")) {
    //             vscode.window.showErrorMessage("Upload and Debug: Please open the script in editor");
    //             return;
    //         }
    //         active = editor.document;

    //         try {
    //             let folder: vscode.WorkspaceFolder | undefined;
    //             if (!vscode.workspace.workspaceFolders) {
    //                 vscode.window.showErrorMessage("Upload and Debug: Workspace Folder missing");
    //                 return;
    //             }
    //             folder = vscode.workspace.workspaceFolders[0];

    //             let config: vscode.DebugConfiguration | undefined;
    //             const jsonContent = fs.readFileSync(loginData.configFile, 'utf8');
    //             const jsonObject = JSON.parse(stripJsonComments(jsonContent));
    //             const configurations = jsonObject.configurations;
    //             // VS Code API doesn't work here:
    //             // vscode.workspace.getConfiguration('launch').configurations.forEach((element: vscode.DebugConfiguration) => {
    //             configurations.forEach((element: vscode.DebugConfiguration) => {
    //                 if (element.type === 'janus' && element.request === 'launch') {
    //                     config = element;
    //                     config.portal = true;
    //                     config.script = active.fileName;
    //                 }
    //             });

    //             if (!config) {
    //                 vscode.window.showErrorMessage("Upload and Debug: No suitable configuration found. Please add one in launch.json");
    //                 return;
    //             }

    //             const scriptPath = await upload.uploadActiveScript(loginData, active, statusBarItem, true);
    //             if (scriptPath) {
    //                 // await serverCommands.uploadDebugScript(loginData, path.basename(scriptPath, ".js"), scriptChannel);
    //                 await vscode.debug.startDebugging(folder, config);
    //             } else {
    //                 vscode.window.showErrorMessage("Upload and Debug: Uploading script failed");
    //             }
    //         } catch (err) {
    //             //
    //         }
    //         helpers.showWarning(loginData);
    //     })
    // );

}



// class DebugConfigurationProvider implements vscode.DebugConfigurationProvider {
//     /**
//      * Massage a debug configuration just before a debug session is being launched,
//      * e.g. add all missing attributes to the debug configuration.
//      */
//     public resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

//         // if launch.json is missing or empty allow quick access to
//         // debugging by providing this config
//         if (!config.type && !config.request && !config.name) {
//             const editor = vscode.window.activeTextEditor;
//             if (editor && editor.document.languageId === 'javascript') {
//                 config.type = 'jsrdbg';
//                 config.name = 'Launch with jsrdbg';
//                 config.request = 'launch';
//                 config.script = '${file}';
//                 config.stopOnEntry = true;
//             }
//         }

//         config.processId = process.pid;
//         if (vscode.workspace.workspaceFolders) {
//             config.workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
//         }

//         return config;
//     }

//     /**
//      * Returns initial debug configurations.
//      */
//     public provideDebugConfigurations?(folder: vscode.WorkspaceFolder | undefined, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration[]> {
//         return provideInitialConfigurations(vscode.workspace.rootPath);
//     }
// }


// this method is called when your extension is deactivated
export function deactivate() {}
