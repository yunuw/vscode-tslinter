/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { workspace, ExtensionContext, commands, window } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, RequestType, TextDocumentIdentifier } from 'vscode-languageclient';

interface RunTSLintParams {
	readonly textDocument: TextDocumentIdentifier;
}

namespace RunTSLintRequest {
	export const type = new RequestType<RunTSLintParams, void, void, void>('textDocument/typescript/runtslint');
}

export function activate(context: ExtensionContext) {

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('server', 'server.js'));
	// The debug options for the server
	let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"], cwd: process.cwd() };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc, options: { cwd: process.cwd() } },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	}
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		//documentSelector: [{ scheme: 'file', language: 'typscript' }],
		documentSelector: ['typescript'],
		synchronize: {
			// Notify the server about file changes to tslint.json files contain in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/tslint.json')
		},
		diagnosticCollectionName: 'tslint'
	}

	// Create the language client and start the client.
	let client = new LanguageClient('tslinter', 'tslinter', serverOptions, clientOptions);

	// Push the disposable to the context's subscriptions so that the 
	// client can be deactivated on extension deactivation
	context.subscriptions.push(
		client.start(),
		// TODO: add status bar so user knows whether tslint is running or not
		commands.registerCommand('typescript.runTSLint', () => runTSLint(client)),
		commands.registerCommand('typescript.fixTSLintError', fixTSLintError),
	);
}

function runTSLint(client: LanguageClient) {
	let textEditor = window.activeTextEditor;
	if (!textEditor) {
		return;
	}
	let uri: string = textEditor.document.uri.toString();
	client.sendRequest(RunTSLintRequest.type, { textDocument: { uri } }).then((result) => {
		if (result) {
			//applyTextEdits(uri, result.documentVersion, result.edits);
		}
	}, (error) => {
		window.showErrorMessage(`Failed to run tslint. ${error}`);
	});
}

function fixTSLintError() {
	window.showInformationMessage('fix tslint');
}