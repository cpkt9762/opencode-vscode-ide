/// <reference path="../../../src/vscode-dts/vscode.proposed.opencodeEditor.d.ts" />

import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext) {
	let lastViewZone: vscode.opencodeEditor.OpencodeViewZone | undefined
	let lastOverlayWidget: vscode.opencodeEditor.OpencodeOverlayWidget | undefined
	let lastContentWidget: vscode.opencodeEditor.OpencodeContentWidget | undefined

	const getActiveEditor = () => {
		const editor = vscode.window.activeTextEditor
		if (editor) return editor
		void vscode.window.showErrorMessage('No active editor')
		return undefined
	}

	const createViewZone = vscode.commands.registerCommand('opencode-sample.createViewZone', async () => {
		const editor = getActiveEditor()
		if (!editor) return

		const zone = await vscode.opencodeEditor.createViewZone(editor, {
			afterLineNumber: 1,
			heightInLines: 3,
			content: {
				html: '<div style="background:#2d2d2d;color:#e0e0e0;padding:8px;font-family:monospace">OpenCode ViewZone</div>',
			},
		})

		lastViewZone = zone
		void vscode.window.showInformationMessage(`ViewZone created: id=${zone.id}`)
	})

	const createOverlayWidget = vscode.commands.registerCommand('opencode-sample.createOverlayWidget', async () => {
		const editor = getActiveEditor()
		if (!editor) return

		const overlay = await vscode.opencodeEditor.createOverlayWidget(editor, {
			id: 'opencode-sample.overlay',
			content: {
				html: '<div style="background:#1a1a2e;color:#16c6f7;padding:12px;border-radius:8px;font-weight:bold">OpenCode Overlay</div>',
			},
			position: { preference: 'TOP_RIGHT_CORNER' },
		})

		lastOverlayWidget = overlay
		void vscode.window.showInformationMessage(`OverlayWidget created: id=${overlay.id}`)
	})

	const createContentWidget = vscode.commands.registerCommand('opencode-sample.createContentWidget', async () => {
		const editor = getActiveEditor()
		if (!editor) return

		const contentWidget = await vscode.opencodeEditor.createContentWidget(editor, {
			id: 'opencode-sample.content',
			content: {
				html: '<div style="background:#0d3b66;color:#faf0ca;padding:4px 8px;border-radius:4px">OpenCode Content</div>',
			},
			position: {
				line: editor.selection.active.line + 1,
				column: editor.selection.active.character + 1,
			},
		})

		lastContentWidget = contentWidget
		void vscode.window.showInformationMessage(`ContentWidget created: id=${contentWidget.id}`)
	})

	const disposeViewZone = vscode.commands.registerCommand('opencode-sample.disposeViewZone', () => {
		if (!lastViewZone) {
			void vscode.window.showWarningMessage('No ViewZone to dispose')
			return
		}

		lastViewZone.dispose()
		lastViewZone = undefined
		void vscode.window.showInformationMessage('ViewZone disposed')
	})

	const disposeOverlayWidget = vscode.commands.registerCommand('opencode-sample.disposeOverlayWidget', () => {
		if (!lastOverlayWidget) {
			void vscode.window.showWarningMessage('No OverlayWidget to dispose')
			return
		}

		lastOverlayWidget.dispose()
		lastOverlayWidget = undefined
		void vscode.window.showInformationMessage('OverlayWidget disposed')
	})

	const disposeContentWidget = vscode.commands.registerCommand('opencode-sample.disposeContentWidget', () => {
		if (!lastContentWidget) {
			void vscode.window.showWarningMessage('No ContentWidget to dispose')
			return
		}

		lastContentWidget.dispose()
		lastContentWidget = undefined
		void vscode.window.showInformationMessage('ContentWidget disposed')
	})

	context.subscriptions.push(
		createViewZone,
		createOverlayWidget,
		createContentWidget,
		disposeViewZone,
		disposeOverlayWidget,
		disposeContentWidget,
		{
			dispose() {
				lastViewZone?.dispose()
				lastOverlayWidget?.dispose()
				lastContentWidget?.dispose()
			},
		},
	)
}
