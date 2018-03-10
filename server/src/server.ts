/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments,
	InitializeResult,
	TextDocumentIdentifier,
	RequestType,
	Files,
	Diagnostic,
	DiagnosticSeverity,
	TextEdit,
	Position,
	TextDocument,
	Range
} from 'vscode-languageserver';
import * as tslint from 'tslint'; // this is a dev dependency only
import Uri from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';
import * as semver from 'semver';
import { IConfigurationFile } from 'tslint/lib/configuration';
import { Replacement } from 'tslint';

interface TSLintAutofixEdit {
	range: [Position, Position];
	text: string;
}

interface RunTSLintParams {
	readonly textDocument: TextDocumentIdentifier;
}

namespace RunTSLintRequest {
	export const type = new RequestType<RunTSLintParams, void, void, void>('textDocument/typescript/runtslint');
}

interface FixTSLintParams {
	readonly textDocument: TextDocumentIdentifier;
}

interface FixTSLintResult {
	readonly documentVersion: number;
	readonly edits: TextEdit[];
	readonly ruleId?: string;
}

namespace FixTSLintRequest {
	export const type = new RequestType<FixTSLintParams, FixTSLintResult, void, void>('textDocument/tslint/fixtslint');
}

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Cache from document URI to tslint library.
let document2Library: Map<string, any> = new Map();
// Cache from tslint path to library. This is used to improve the performance further, as different document may have the same tslint module path.
// if tslint < tslint4 then the linter is the module therefore the type `any`
let path2Library: Map<string, any> = new Map();
// Cache from .ts file to tslint config, so we don't need to load the configuration everytime
let document2Configuration: Map<string, IConfigurationFile> = new Map();

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {

	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind
		}
	};
});

// The watched tslint.json has changed.
connection.onDidChangeWatchedFiles((params) => {
	// TODO: handle the update more gracefully, i.e., check if the changes tslint.json rules over the document
	document2Configuration.clear();
	params.changes.forEach(element => {
		console.log("Detect tslint.json file change " + element.uri);
	});
});

function trace(message: string, verbose?: string): void {
	connection.tracer.log(message, verbose);
}

documents.onDidClose((event) => {
	// clear the result if the document is closed
	connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onRequest(RunTSLintRequest.type, async (params) => {
	let lintErrors = await runTSLint(params.textDocument.uri);

	// Send diagnostics
	let diagnostics: Diagnostic[] = [];
	if (lintErrors) {
		lintErrors.failures.forEach(failure => {
			diagnostics.push(makeDiagnostic(failure));
		});
	}
	connection.sendDiagnostics({ uri: params.textDocument.uri, diagnostics });
});

async function loadLibrary(filePath: string) {
	let directory = path.dirname(filePath);
	let tslintPath = await Files.resolve('tslint', undefined, directory, trace).then(undefined, () => {
		// if can't find tslint module in current directory, try find it in global npm scope
		return Files.resolve('tslint', Files.resolveGlobalNodePath(trace), directory, trace).then(undefined, () => {
			// it not exist in global npm path, find it in global yarn path
			return Files.resolve('tslint', Files.resolveGlobalYarnPath(trace), directory, trace);
		});
	});

	connection.console.log("Found tslint path: " + tslintPath);
	if (!tslintPath) {
		return null;
	}

	let library = path2Library.get(tslintPath);
	if (!library) {
		library = require(tslintPath);
		path2Library.set(tslintPath, library);
	}

	return library;
}

function getLinterFromLibrary(library: any): typeof tslint.Linter {
	let isTsLint4 = isTsLintVersion4(library);
	let linter;
	if (!isTsLint4) {
		linter = library;
	} else {
		linter = library.Linter;
	}
	return linter;
}

function isTsLintVersion4(library: any) {
	let version = '1.0.0';
	try {
		version = library.Linter.VERSION;
	} catch (e) {
	}
	return !(semver.satisfies(version, "<= 3.x.x"));
}

function getConfiguration(filePath: string, library: any): IConfigurationFile {
	let parsedPath = path.parse(filePath);
	let currentDirectory = parsedPath.dir;
	while (!fs.existsSync(path.join(currentDirectory, "tslint.json"))) {
		let splits = currentDirectory.split(path.sep);
		if (splits.length === 1) {
			// No config file at root directory
			return null;
		}
		currentDirectory = splits.slice(0, splits.length - 1).join(path.sep);
	}
	
	let linter = getLinterFromLibrary(library);
	return <tslint.Configuration.IConfigurationFile>linter.loadConfigurationFromPath(path.join(currentDirectory, "tslint.json"));
}

function makeDiagnostic(problem: tslint.RuleFailure): Diagnostic {
	let message = (problem.getRuleName())
		? `${problem.getFailure()} (${problem.getRuleName()})`
		: `${problem.getFailure()}`;

	let diagnostic: Diagnostic = {
		severity: DiagnosticSeverity.Warning,
		message: message,
		range: {
			start: {
				line: problem.getStartPosition().getLineAndCharacter().line,
				character: problem.getStartPosition().getLineAndCharacter().character
			},
			end: {
				line: problem.getEndPosition().getLineAndCharacter().line,
				character: problem.getEndPosition().getLineAndCharacter().character
			},
		},
		code: problem.getRuleName(),
		source: 'tslinter'
	};

	return diagnostic;
}

async function runTSLint(documentUri: string): Promise<tslint.LintResult> {
	let parsedUri = Uri.parse(documentUri);
	if (parsedUri.scheme !== 'file') {
		connection.console.error(`Failed to run tslint. The provided document URI ${documentUri} is not a file.`);
		return null;
	}
	let filePath = parsedUri.fsPath;

	// Get tslint library
	let library = document2Library.get(filePath);
	if (!library) {
		library = await loadLibrary(filePath);
		if (!library) {
			// TODO: handle this case, i.e., install tslint for the user
			connection.console.error(`Failed to run tslint. Can't find tslint module.`);
			return null;
		}

		document2Library.set(filePath, library);
	}

	// Get tslint config
	let configuration = document2Configuration.get(filePath);
	if (!configuration) {
		configuration = getConfiguration(filePath, library);
		if (!configuration) {
			// TODO: handle this case, i.e., create tslint config for the user
			connection.console.error(`Failed to run tslint. No tslint configuration file.`);
			return null;
		}

		document2Configuration.set(filePath, configuration);
	}

	// Run tslint on document
	let contents = documents.get(documentUri).getText();
	let options: tslint.ILinterOptions = {
		formatter: "json",
		fix: false
	};
	let linter = getLinterFromLibrary(library);
	let result: tslint.LintResult;

	if (isTsLintVersion4(library)) {
		let tslint = new linter(options);
		tslint.lint(filePath, contents, configuration);
		result = tslint.getResult();
	}
	else {
		(<any>options).configuration = configuration;
		let tslint = new (<any>linter)(filePath, contents, options);
		result = tslint.lint();
	}

	return result;
}

connection.onRequest(FixTSLintRequest.type, async (params) => {
	let document = documents.get(params.textDocument.uri);
	let documentVersion = document.version;
	let lintErrors = await runTSLint(params.textDocument.uri);
	if (!lintErrors) {
		return {
			documentVersion: documentVersion,
			edits: []
		};
	}

	let autoFixes: TSLintAutofixEdit[][] = [];
	lintErrors.failures.forEach(failure => {
		// tslint fixes are not available in tslint < 3.17
		if (failure.getFix && failure.getFix()) {
			let fix: any = failure.getFix();
			// in tslint4 a Fix has a replacement property with the Replacements
			if (fix.replacements) {
				// tslint4
				let edits = fix.replacements.map((each: Replacement) => convertReplacementToAutoFix(document, each));
				if (edits.length > 0) {
					autoFixes.push(edits);
				}
			} else {
				// in tslint 5 a Fix is a Replacment | Replacement[]
				if (!Array.isArray(fix)) {
					fix = [fix];
				}
				let edits = fix.map((each: Replacement) => convertReplacementToAutoFix(document, each));
				if (edits.length > 0) {
					autoFixes.push(edits);
				}
			}
		}
	});

	let textEdits: TextEdit[] = [];
	autoFixes.forEach(fix => {
		let currentFixTextEdits = fix.map(each => TextEdit.replace(Range.create(each.range[0], each.range[1]), each.text || ''));
		textEdits = textEdits.concat(currentFixTextEdits);
	});

	return {
		documentVersion: documentVersion,
		edits: textEdits
	};
});

function convertReplacementToAutoFix(document: TextDocument, repl: tslint.Replacement): TSLintAutofixEdit {
	let start: Position = document.positionAt(repl.start);
	let end: Position = document.positionAt(repl.end);
	return {
		range: [start, end],
		text: repl.text,
	};
}

// Listen on the connection
connection.listen();
