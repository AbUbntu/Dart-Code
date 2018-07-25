import * as assert from "assert";
import * as vs from "vscode";
import { activate, doc, extApi, positionOf, setTestContent } from "../../helpers";

describe("dart_signature_provider", () => {
	beforeEach("activate", () => activate());
	beforeEach("skip if analyzer doesn't support getSignature", function () {
		if (!extApi.analyzerCapabilities.supportsGetSignature)
			this.skip();
	});

	async function getSignatureAt(searchText: string): Promise<vs.SignatureHelp> {
		const position = positionOf(searchText);
		return (vs.commands.executeCommand("vscode.executeSignatureHelpProvider", doc.uri, position) as Thenable<vs.SignatureHelp>);
	}

	it("returns undefined for invalid area", async () => {
		await setTestContent(`
main() {
  print("test
}
		`);
		const sig = await getSignatureAt("^main");
		assert.ok(!sig);
	});

	it("returns simple sig", async () => {
		await setTestContent(`
main() {
  print("here
}
		`);
		const sig = await getSignatureAt("here^");
		assert.ok(sig);
		assert.equal(sig.activeParameter, 0);
		assert.equal(sig.activeSignature, 0);
		assert.equal(sig.signatures.length, 1);
		assert.equal(sig.signatures[0].label, "print");
		assert.equal(sig.signatures[0].documentation, "Prints a string representation of the object to the console.");
		assert.equal(sig.signatures[0].parameters.length, 1);
		assert.equal(sig.signatures[0].parameters[0].label, "Object object");
		assert.equal(sig.signatures[0].parameters[0].documentation, undefined);
	});

});
