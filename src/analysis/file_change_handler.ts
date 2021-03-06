import * as vs from "vscode";
import { config } from "../config";
import * as util from "../utils";
import { fsPath } from "../utils";
import * as as from "./analysis_server_types";
import { Analyzer } from "./analyzer";

export class FileChangeHandler implements vs.Disposable {
	private disposables: vs.Disposable[] = [];
	private analyzer: Analyzer;
	private readonly filesWarnedAbout = new Set<string>();
	constructor(analyzer: Analyzer) {
		this.analyzer = analyzer;

		this.disposables.push(
			vs.workspace.onDidOpenTextDocument((td) => this.onDidOpenTextDocument(td)),
			vs.workspace.onDidChangeTextDocument((e) => this.onDidChangeTextDocument(e)),
			vs.workspace.onDidCloseTextDocument((td) => this.onDidCloseTextDocument(td)),
		);
		// Handle already-open files.
		vs.workspace.textDocuments.forEach((td) => this.onDidOpenTextDocument(td));
	}

	public onDidOpenTextDocument(document: vs.TextDocument) {
		if (!util.isAnalyzable(document))
			return;

		const files: { [key: string]: as.AddContentOverlay } = {};

		files[fsPath(document.uri)] = {
			content: document.getText(),
			type: "add",
		};

		this.analyzer.analysisUpdateContent({ files });
	}

	public onDidChangeTextDocument(e: vs.TextDocumentChangeEvent) {
		if (!util.isAnalyzable(e.document))
			return;

		if (e.contentChanges.length === 0) // This event fires for metadata changes (dirty?) so don't need to notify AS then.
			return;

		const filePath = fsPath(e.document.uri);

		if (config.warnWhenEditingFilesOutsideWorkspace && !this.filesWarnedAbout.has(filePath) && !util.isWithinWorkspace(filePath)) {
			vs.window.showWarningMessage(`You are modifying a file outside of your current workspace: ${filePath}`);
			this.filesWarnedAbout.add(filePath);
		}

		const files: { [key: string]: as.ChangeContentOverlay } = {};
		files[filePath] = {
			edits: e.contentChanges.map((c) => this.convertChange(e.document, c)),
			type: "change",
		};
		this.analyzer.analysisUpdateContent({ files });
	}

	public onDidCloseTextDocument(document: vs.TextDocument) {
		if (!util.isAnalyzable(document))
			return;

		const files: { [key: string]: as.RemoveContentOverlay } = {};

		files[fsPath(document.uri)] = {
			type: "remove",
		};

		this.analyzer.analysisUpdateContent({ files });
	}

	private convertChange(document: vs.TextDocument, change: vs.TextDocumentContentChangeEvent): as.SourceEdit {
		return {
			id: "",
			length: change.rangeLength,
			offset: change.rangeOffset,
			replacement: change.text,
		};
	}

	public dispose(): any {
		this.disposables.forEach((d) => d.dispose());
	}
}
