import * as assert from "assert";
import * as fs from "fs";
import * as _ from "lodash";
import { tmpdir } from "os";
import * as path from "path";
import * as semver from "semver";
import * as vs from "vscode";
import { AnalyzerCapabilities } from "../src/analysis/analyzer";
import { dartCodeExtensionIdentifier } from "../src/debug/utils";
import { DaemonCapabilities } from "../src/flutter/flutter_daemon";
import { DartRenameProvider } from "../src/providers/dart_rename_provider";
import { DebugConfigProvider } from "../src/providers/debug_config_provider";
import { internalApiSymbol } from "../src/symbols";
import { fsPath, ProjectType, Sdks, vsCodeVersionConstraint } from "../src/utils";
import { log, logError, logTo, logWarn } from "../src/utils/log";
import { TestResultsProvider } from "../src/views/test_view";
import sinon = require("sinon");

export const ext = vs.extensions.getExtension(dartCodeExtensionIdentifier);
export let extApi: {
	analyzerCapabilities: AnalyzerCapabilities,
	currentAnalysis: () => Promise<void>,
	daemonCapabilities: DaemonCapabilities,
	debugProvider: DebugConfigProvider,
	nextAnalysis: () => Promise<void>,
	initialAnalysis: Promise<void>,
	reanalyze: () => void,
	renameProvider: DartRenameProvider,
	sdks: Sdks,
	testTreeProvider: TestResultsProvider,
};

if (!ext) {
	if (semver.satisfies(vs.version, vsCodeVersionConstraint)) {
		logError("Quitting with error because extension failed to load.");
		process.exit(1);
	} else {
		logError("Skipping because extension failed to load due to requiring newer VS Code version.");
		logError(`    Required: ${vsCodeVersionConstraint}`);
		logError(`    Current: ${vs.version}`);
		process.exit(0);
	}
}

export const helloWorldFolder = vs.Uri.file(path.join(ext.extensionPath, "test/test_projects/hello_world"));
export const helloWorldMainFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "bin/main.dart"));
export const helloWorldTestMainFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "test/basic_test.dart"));
export const helloWorldTestTreeFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "test/tree_test.dart"));
export const helloWorldTestBrokenFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "test/broken_test.dart"));
export const helloWorldTestSkipFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "test/skip_test.dart"));
export const helloWorldGettersFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "bin/getters.dart"));
export const helloWorldBrokenFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "bin/broken.dart"));
export const helloWorldGoodbyeFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "bin/goodbye.dart"));
export const helloWorldHttpFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "bin/http.dart"));
export const helloWorldCreateMethodClassAFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "lib/create_method/class_a.dart"));
export const helloWorldCreateMethodClassBFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "lib/create_method/class_b.dart"));
export const emptyFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "lib/empty.dart"));
export const helloWorldCompletionFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "lib/completion.dart"));
export const everythingFile = vs.Uri.file(path.join(fsPath(helloWorldFolder), "lib/everything.dart"));
export const flutterHelloWorldFolder = vs.Uri.file(path.join(ext.extensionPath, "test/test_projects/flutter_hello_world"));
export const flutterEmptyFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "lib/empty.dart"));
export const flutterHelloWorldMainFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "lib/main.dart"));
export const flutterHelloWorldExampleSubFolder = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "example"));
export const flutterHelloWorldExampleSubFolderMainFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldExampleSubFolder), "lib/main.dart"));
export const flutterHelloWorldBrokenFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "lib/broken.dart"));
export const flutterTestMainFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "test/widget_test.dart"));
export const flutterTestOtherFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "test/other_test.dart"));
export const flutterTestBrokenFile = vs.Uri.file(path.join(fsPath(flutterHelloWorldFolder), "test/broken_test.dart"));

// TODO: Make these always return for the current active file (which is what many tests already use).
export let doc: vs.TextDocument;
export let editor: vs.TextEditor;
export let documentEol: string;

function getDefaultFile(): vs.Uri {
	if (extApi.sdks.projectType === ProjectType.Dart)
		return emptyFile;
	else
		return flutterEmptyFile;
}

export async function activateWithoutAnalysis(): Promise<void> {
	log("Activating");
	await ext.activate();
	extApi = ext.exports[internalApiSymbol];
}

export async function activate(file?: vs.Uri): Promise<void> {
	await activateWithoutAnalysis();
	if (!file)
		file = getDefaultFile();

	if (extApi && extApi.sdks && extApi.sdks.projectType === ProjectType.Flutter) {
		log("Restoring packages for Flutter project");
		await vs.commands.executeCommand("dart.getPackages", vs.workspace.workspaceFolders ? [0] : undefined);
	}

	log(`Closing all open files`);
	await closeAllOpenFiles();
	log(`Opening ${fsPath(file)}`);
	doc = await vs.workspace.openTextDocument(file);
	log(`Showing ${fsPath(file)}`);
	editor = await vs.window.showTextDocument(doc);
	documentEol = doc.eol === vs.EndOfLine.CRLF ? "\r\n" : "\n";
	log(`Waiting for initial and any in-progress analysis`);
	await extApi.initialAnalysis;
	// Opening a file above may start analysis after a short period so give it time to start
	// before we continue.
	await delay(200);
	await extApi.currentAnalysis();
	log(`Ready to start test`);
}

export async function getPackages() {
	log("Restoring packages and waiting for next analysis to complete");
	await activateWithoutAnalysis();
	if (!vs.workspace.workspaceFolders || !vs.workspace.workspaceFolders.length) {
		logError("Cannoy getPackages because there is no workspace folder");
		return;
	}
	await waitForNextAnalysis(async () => {
		await vs.commands.executeCommand("dart.getPackages", vs.workspace.workspaceFolders[0]);
	}, 60);
}

export async function closeAllOpenFiles(): Promise<void> {
	while (vs.window.activeTextEditor) {
		await vs.commands.executeCommand("workbench.action.closeActiveEditor");
		await delay(5);
	}
}

export async function closeFile(file: vs.Uri): Promise<void> {
	for (const editor of vs.window.visibleTextEditors) {
		if (editor.document.uri === file) {
			await vs.window.showTextDocument(editor.document);
			await vs.commands.executeCommand("workbench.action.closeActiveEditor");
		}
	}
}

export async function openFile(file: vs.Uri): Promise<vs.TextEditor> {
	return vs.window.showTextDocument(await vs.workspace.openTextDocument(file));
}

beforeEach("set logger", async function () {
	const logFolder = process.env.DC_TEST_LOGS || path.join(ext.extensionPath, ".dart_code_test_logs");
	if (!fs.existsSync(logFolder))
		fs.mkdirSync(logFolder);
	const logFile = filenameSafe(this.currentTest.fullTitle()) + ".txt";
	const logPath = path.join(logFolder, logFile);

	const logger = logTo(logPath);

	deferUntilLast(async (testResult: "passed" | "failed") => {
		await logger.dispose();
		// On CI, we delete logs for passing tests to save money on S3 :-)
		if (process.env.CI && testResult === "passed") {
			try {
				fs.unlinkSync(logPath);
			} catch { }
		}
	});
});

export let sb: sinon.SinonSandbox;
beforeEach("create sinon sandbox", function () { sb = sinon.createSandbox(); }); // tslint:disable-line:only-arrow-functions
afterEach("destroy sinon sandbox", () => sb.restore());

before("throw if DART_CODE_IS_TEST_RUN is not set", () => {
	if (!process.env.DART_CODE_IS_TEST_RUN)
		throw new Error("DART_CODE_IS_TEST_RUN env var should be set for test runs.");
});

const deferredItems: Array<(result?: "failed" | "passed") => Promise<any> | any> = [];
const deferredToLastItems: Array<(result?: "failed" | "passed") => Promise<any> | any> = [];
// tslint:disable-next-line:only-arrow-functions
afterEach("run deferred functions", async function () {
	let firstError: any;
	for (const d of _.concat(deferredItems, deferredToLastItems)) {
		try {
			await d(this.currentTest.state);
		} catch (e) {
			logError(`Error running deferred function: ${e}`);
			// TODO: Add named for deferred functions instead...
			logWarn(d.toString());
			firstError = firstError || e;
		}
	}
	deferredItems.length = 0;
	deferredToLastItems.length = 0;
	// We delay throwing until the end so that other cleanup can run
	if (firstError)
		throw firstError;
});
export function defer(callback: (result?: "failed" | "passed") => Promise<any> | any): void {
	deferredItems.push(callback);
}
export function deferUntilLast(callback: (result?: "failed" | "passed") => Promise<any> | any): void {
	deferredToLastItems.push(callback);
}

export async function setTestContent(content: string): Promise<boolean> {
	const all = new vs.Range(
		doc.positionAt(0),
		doc.positionAt(doc.getText().length),
	);
	// TODO: May be able to replace this with
	// return editor.edit((eb) => eb.replace(all, content));
	// once the fix for https://github.com/dart-lang/sdk/issues/32914
	// has made it all the way through.
	return editor.edit((eb) => eb.replace(all, content));
}

export async function uncommentTestFile(): Promise<void> {
	await setTestContent(doc.getText().replace(/\n\/\/ /mg, "\n"));
}

export function getExpectedResults() {
	const start = positionOf("// == EXPECTED RESULTS ==^");
	const end = positionOf("^// == /EXPECTED RESULTS ==");
	const doc = vs.window.activeTextEditor.document;
	const results = doc.getText(new vs.Range(start, end));
	return results.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("// ") && !l.startsWith("// #")) // Allow "comment" lines within the comment
		.map((l) => l.substr(3))
		.join("\n");
}

export function select(range: vs.Range) {
	editor.selection = new vs.Selection(range.start, range.end);
}

export function positionOf(searchText: string): vs.Position {
	const doc = vs.window.activeTextEditor.document;
	const caretOffset = searchText.indexOf("^");
	assert.notEqual(caretOffset, -1, `Couldn't find a ^ in search text (${searchText})`);
	const matchedTextIndex = doc.getText().indexOf(searchText.replace("^", "").replace(/\n/g, documentEol));
	assert.notEqual(matchedTextIndex, -1, `Couldn't find string ${searchText.replace("^", "")} in the document to get position of`);

	return doc.positionAt(matchedTextIndex + caretOffset);
}

export function rangeOf(searchText: string, inside?: vs.Range): vs.Range {
	const doc = vs.window.activeTextEditor.document;
	const startOffset = searchText.indexOf("|");
	assert.notEqual(startOffset, -1, `Couldn't find a | in search text (${searchText})`);
	const endOffset = searchText.lastIndexOf("|");
	assert.notEqual(endOffset, -1, `Couldn't find a second | in search text (${searchText})`);

	const startSearchAt = inside ? doc.offsetAt(inside.start) : 0;
	const endSearchAt = inside ? doc.offsetAt(inside.end) : -1;
	let matchedTextIndex = doc.getText().indexOf(searchText.replace(/\|/g, "").replace(/\n/g, documentEol), startSearchAt);
	if (endSearchAt > -1 && matchedTextIndex > endSearchAt)
		matchedTextIndex = -1;
	assert.notEqual(matchedTextIndex, -1, `Couldn't find string ${searchText.replace(/\|/g, "")} in the document to get range of`);

	return new vs.Range(
		doc.positionAt(matchedTextIndex + startOffset),
		doc.positionAt(matchedTextIndex + endOffset - 1),
	);
}

export async function getDocumentSymbols(): Promise<vs.SymbolInformation[]> {
	const documentSymbolResult = await (vs.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri) as Thenable<vs.SymbolInformation[]>);
	return documentSymbolResult || [];
}

export async function getDefinitions(position: vs.Position): Promise<vs.Location[]> {
	const doc = vs.window.activeTextEditor.document;
	const definitionResult = await (vs.commands.executeCommand("vscode.executeDefinitionProvider", doc.uri, position) as Thenable<vs.Location[]>);
	return definitionResult || [];
}

export async function getDefinition(position: vs.Position): Promise<vs.Location> {
	const defs = await getDefinitions(position);
	assert.ok(defs && defs.length);
	return defs[0];
}

export async function getWorkspaceSymbols(query: string): Promise<vs.SymbolInformation[]> {
	const workspaceSymbolResult = await (vs.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query) as Thenable<vs.SymbolInformation[]>);
	return workspaceSymbolResult || [];
}

export function waitForDiagnosticChange(resource?: vs.Uri): Promise<void> {
	return new Promise((resolve, reject) => {
		const disposable = vs.languages.onDidChangeDiagnostics((e) => {
			if (!resource || e.uris.find((r) => fsPath(r) === fsPath(resource))) {
				resolve();
				disposable.dispose();
			}
		});
	});
}

export function ensureError(errors: vs.Diagnostic[], text: string) {
	const error = errors.find((e) => e.message.indexOf(text) !== -1);
	assert.ok(
		error,
		`Couldn't find error for ${text} in\n`
		+ errors.map((e) => `        ${e.message}`).join("\n"),
	);
}

export function ensureSymbol(symbols: vs.SymbolInformation[], name: string, kind: vs.SymbolKind, containerName?: string, uri: vs.Uri = doc.uri, shouldHaveRange = true): void {
	const symbol = symbols.find((f) =>
		f.name === name
		&& f.kind === kind
		&& (f.containerName || "") === (containerName || ""),
	);
	assert.ok(
		symbol,
		`Couldn't find symbol for ${name}/${vs.SymbolKind[kind]}/${containerName} in\n`
		+ symbols.map((s) => `        ${s.name}/${vs.SymbolKind[s.kind]}/${s.containerName}`).join("\n"),
	);
	assert.equal(fsPath(symbol.location.uri), fsPath(uri));
	assert.ok(symbol.location);
	if (shouldHaveRange) {
		assert.ok(symbol.location.range);
		assert.ok(symbol.location.range.start);
		assert.ok(symbol.location.range.start.line);
		assert.ok(symbol.location.range.end);
		assert.ok(symbol.location.range.end.line);
	} else {
		assert.ok(!symbol.location.range);
	}
}

function rangeString(range: vs.Range) {
	return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

export function ensureLocation(locations: vs.Location[], uri: vs.Uri, range: vs.Range): void {
	const location = locations.find((l) =>
		l.uri.toString() === uri.toString()
		&& l.range.isEqual(range),
	);
	assert.ok(
		location,
		`Couldn't find location for ${uri}/${rangeString(range)} in\n`
		+ locations.map((l) => `        ${l.uri}/${rangeString(l.range)}`).join("\n"),
	);
}

export function ensureNoLocation(locations: vs.Location[], uri: vs.Uri, range: vs.Range): void {
	const location = locations.find((l) =>
		l.uri.toString() === uri.toString()
		&& l.range.isEqual(range),
	);
	assert.ok(
		!location,
		`Unexpectedly found location for ${uri}/${rangeString(range)}`,
	);
}

export function ensureIsRange(actual: vs.Range, expected: vs.Range) {
	assert.ok(actual);
	assert.equal(actual.start.line, expected.start.line, "Start lines did not match");
	assert.equal(actual.start.character, expected.start.character, "Start characters did not match");
	assert.equal(actual.end.line, expected.end.line, "End lines did not match");
	assert.equal(actual.end.character, expected.end.character, "End characters did not match");
}

export async function getCompletionsAt(searchText: string, triggerCharacter?: string): Promise<vs.CompletionItem[]> {
	const position = positionOf(searchText);
	const results = await (vs.commands.executeCommand("vscode.executeCompletionItemProvider", doc.uri, position, triggerCharacter) as Thenable<vs.CompletionList>);
	return results.items;
}

export async function getSnippetCompletionsAt(searchText: string, triggerCharacter?: string): Promise<vs.CompletionItem[]> {
	const completions = await getCompletionsAt(searchText, triggerCharacter);
	return completions.filter((c) => c.kind === vs.CompletionItemKind.Snippet);
}

export function ensureCompletion(items: vs.CompletionItem[], kind: vs.CompletionItemKind, label: string, filterText?: string, documentation?: string): void {
	const completion = items.find((item) =>
		item.label === label
		&& item.filterText === filterText
		&& item.kind === kind,
	);
	assert.ok(
		completion,
		`Couldn't find completion for ${label}/${filterText} in\n`
		+ items.map((item) => `        ${vs.CompletionItemKind[item.kind]}/${item.label}/${item.filterText}`).join("\n"),
	);
	if (documentation) {
		assert.equal(((completion.documentation as any).value as string).trim(), documentation);
	}
}

export function ensureSnippet(items: vs.CompletionItem[], label: string, filterText: string, documentation?: string): void {
	ensureCompletion(items, vs.CompletionItemKind.Snippet, label, filterText, documentation);
}

export function ensureNoCompletion(items: vs.CompletionItem[], kind: vs.CompletionItemKind, label: string): void {
	const completion = items.find((item) =>
		(item.label === label || item.filterText === label)
		&& item.kind === kind,
	);
	assert.ok(
		!completion,
		`Found unexpected completion for ${label}`,
	);
}

export function ensureNoSnippet(items: vs.CompletionItem[], label: string): void {
	ensureNoCompletion(items, vs.CompletionItemKind.Snippet, label);
}

export async function ensureTestContent(expected: string): Promise<void> {
	// Wait for a short period before checking to reduce changes of flaky tests.
	await waitFor(() =>
		doc.getText().replace(/\r/g, "").trim() === expected.replace(/\r/g, "").trim(),
		"Document content did not match expected",
		100,
		false,
	);
	assert.equal(doc.getText().replace(/\r/g, "").trim(), expected.replace(/\r/g, "").trim());
}

export async function ensureTestContentWithCursorPos(expected: string): Promise<void> {
	await ensureTestContent(expected.replace("^", ""));
	// To avoid issues with newlines not matching up in `expected`, we'll just stick the
	// placeholder character ^ in the cursor location then call ensureTextContent.
	const originalSelection = editor.document.getText(editor.selection);
	try {
		await editor.edit((builder) => builder.replace(editor.selection, "^"));
		await ensureTestContent(expected);
	} finally {
		await editor.edit((builder) => builder.replace(editor.selection, originalSelection));
	}
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function getRandomTempFolder(): string {
	const r = Math.floor(Math.random() * 100000);
	const base = path.join(tmpdir(), "dart-code-tests");
	if (!fs.existsSync(base))
		fs.mkdirSync(base);
	const tmpPath = path.join(base, r.toString());
	if (!fs.existsSync(tmpPath))
		fs.mkdirSync(tmpPath);
	return tmpPath;
}

export async function waitFor(action: () => boolean, message?: string, milliseconds: number = 2000, throwOnFailure = true): Promise<void> {
	let timeRemaining = milliseconds;
	while (timeRemaining > 0) {
		if (action())
			return;
		await new Promise((resolve) => setTimeout(resolve, 20));
		timeRemaining -= 20;
	}
	if (throwOnFailure)
		throw new Error("Action didn't return true within specified timeout" + (message ? ` (${message})` : ""));
}

export async function tryFor(action: () => Promise<void> | void, milliseconds: number = 2000): Promise<void> {
	let timeRemaining = milliseconds;
	while (timeRemaining > 0) {
		try {
			await action();
			return; // We succeeded, so return successfully.
		} catch {
			// Swallow the error so we can try again.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		timeRemaining -= 20;
	}
	// Run normally, so we get a good error message.
	await action();
}

export async function waitForEditorChange(action: () => Thenable<void>): Promise<void> {
	const oldVersion = doc.version;
	await action();
	await waitFor(() => doc.version !== oldVersion);
}

export async function waitForNextAnalysis(action: () => void | Thenable<void>, timeoutSeconds?: number): Promise<void> {
	log("Waiting for any in-progress analysis to complete");
	await extApi.currentAnalysis;
	// Get a new completer for the next analysis.
	const nextAnalysis = extApi.nextAnalysis();
	log("Running requested action");
	await action();
	log(`Waiting for analysis to complete`);
	await withTimeout(nextAnalysis, "Analysis did not complete within specified timeout", timeoutSeconds);
}

export async function withTimeout(promise: Promise<any>, message: string | (() => string), seconds?: number) {
	return Promise.race([
		promise,
		timeoutIn(message, seconds),
	]);
}

export async function timeoutIn(message: string | (() => string), seconds: number = 15) {
	return new Promise((resolve, reject) => setTimeout(() => {
		const msg = typeof message === "string" ? message : message();
		reject(new Error(`${msg} within ${seconds}s`));
	}, seconds * 1000));
}

// This same logic exists in the website to link back to logs.
export function filenameSafe(input: string) {
	return input.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

async function getResolvedDebugConfiguration(extraConfiguration?: { [key: string]: any }): Promise<vs.DebugConfiguration> {
	const debugConfig: vs.DebugConfiguration = Object.assign({}, {
		name: "Dart & Flutter",
		request: "launch",
		type: "dart",
	}, extraConfiguration);
	return await extApi.debugProvider.resolveDebugConfiguration(vs.workspace.workspaceFolders[0], debugConfig);
}

export async function getLaunchConfiguration(script?: vs.Uri | string, extraConfiguration?: { [key: string]: any }): Promise<vs.DebugConfiguration> {
	if (script instanceof vs.Uri)
		script = fsPath(script);
	const launchConfig = Object.assign({}, {
		program: script,
	}, extraConfiguration);
	return await getResolvedDebugConfiguration(launchConfig);
}

export async function getAttachConfiguration(observatoryUri: string, extraConfiguration?: { [key: string]: any }): Promise<vs.DebugConfiguration> {
	const attachConfig = Object.assign({}, {
		observatoryUri,
		request: "attach",
	}, extraConfiguration);
	return await getResolvedDebugConfiguration(attachConfig);
}
