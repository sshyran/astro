import * as fs from 'fs';
import { getHighlighter } from 'shiki';
import { fileURLToPath } from 'url';
import type { ErrorPayload } from 'vite';
import type { ModuleLoader } from '../../module-loader/index.js';
import { AstroErrorData } from '../errors-data.js';
import type { ErrorWithMetadata } from '../errors.js';
import { createSafeError } from '../utils.js';
import { renderErrorMarkdown } from './utils.js';

export function enhanceViteSSRError(error: unknown, filePath?: URL, loader?: ModuleLoader): Error {
	// NOTE: We don't know where the error that's coming here comes from, so we need to be defensive regarding what we do
	// to it to make sure we keep as much information as possible. It's very possible that we receive an error that does not
	// follow any kind of standard formats (ex: a number, a string etc)
	const safeError = createSafeError(error) as ErrorWithMetadata;

	// Vite will give you better stacktraces, using sourcemaps.
	if (loader) {
		try {
			loader.fixStacktrace(safeError as Error);
		} catch {}
	}

	if (filePath) {
		const path = fileURLToPath(filePath);
		const content = fs.readFileSync(path).toString();
		const lns = content.split('\n');

		// Vite has a fairly generic error message when it fails to load a module, let's try to enhance it a bit
		// https://github.com/vitejs/vite/blob/ee7c28a46a6563d54b828af42570c55f16b15d2c/packages/vite/src/node/ssr/ssrModuleLoader.ts#L91
		let importName: string | undefined;
		if ((importName = safeError.message.match(/Failed to load url (.*?) \(resolved id:/)?.[1])) {
			safeError.title = AstroErrorData.FailedToLoadModuleSSR.title;
			safeError.name = 'FailedToLoadModuleSSR';
			safeError.message = AstroErrorData.FailedToLoadModuleSSR.message(importName);
			safeError.hint = AstroErrorData.FailedToLoadModuleSSR.hint;
			safeError.code = AstroErrorData.FailedToLoadModuleSSR.code;
			const line = lns.findIndex((ln) => ln.includes(importName!));

			if (line !== -1) {
				const column = lns[line]?.indexOf(importName);

				safeError.loc = {
					file: path,
					line: line + 1,
					column,
				};
			}
		}

		// Since Astro.glob is a wrapper around Vite's import.meta.glob, errors don't show accurate information, let's fix that
		if (/Invalid glob/.test(safeError.message)) {
			const globPattern = safeError.message.match(/glob: "(.+)" \(/)?.[1];

			if (globPattern) {
				safeError.message = AstroErrorData.InvalidGlob.message(globPattern);
				safeError.name = 'InvalidGlob';
				safeError.hint = AstroErrorData.InvalidGlob.hint;
				safeError.code = AstroErrorData.InvalidGlob.code;
				safeError.title = AstroErrorData.InvalidGlob.title;

				const line = lns.findIndex((ln) => ln.includes(globPattern));

				if (line !== -1) {
					const column = lns[line]?.indexOf(globPattern);

					safeError.loc = {
						file: path,
						line: line + 1,
						column,
					};
				}
			}
		}
	}

	return safeError;
}

export interface AstroErrorPayload {
	type: ErrorPayload['type'];
	err: Omit<ErrorPayload['err'], 'loc'> & {
		name?: string;
		title?: string;
		hint?: string;
		docslink?: string;
		highlightedCode?: string;
		loc: {
			file?: string;
			line?: number;
			column?: number;
		};
	};
}

/**
 * Generate a payload for Vite's error overlay
 */
export async function getViteErrorPayload(err: ErrorWithMetadata): Promise<AstroErrorPayload> {
	let plugin = err.plugin;
	if (!plugin && err.hint) {
		plugin = 'astro';
	}

	const message = renderErrorMarkdown(err.message.trim(), 'html');
	const hint = err.hint ? renderErrorMarkdown(err.hint.trim(), 'html') : undefined;

	const hasDocs =
		(err.type &&
			err.name && [
				'AstroError',
				'AggregateError',
				/* 'CompilerError' ,*/
				'CSSError',
				'MarkdownError',
			]) ||
		['FailedToLoadModuleSSR', 'InvalidGlob'].includes(err.name);

	const docslink = hasDocs
		? `https://docs.astro.build/en/reference/errors/${getKebabErrorName(err.name)}/`
		: undefined;

	const highlighter = await getHighlighter({ theme: 'css-variables' });
	const highlightedCode = err.fullCode
		? highlighter.codeToHtml(err.fullCode, {
				lang: err.loc?.file?.split('.').pop(),
				lineOptions: err.loc?.line ? [{ line: err.loc.line, classes: ['error-line'] }] : undefined,
		  })
		: undefined;

	return {
		type: 'error',
		err: {
			...err,
			name: err.name,
			type: err.type,
			message,
			hint,
			frame: err.frame,
			highlightedCode,
			docslink,
			loc: {
				file: err.loc?.file,
				line: err.loc?.line,
				column: err.loc?.column,
			},
			plugin,
			stack: err.stack,
		},
	};

	/**
	 * The docs has kebab-case urls for errors, so we need to convert the error name
	 * @param errorName
	 */
	function getKebabErrorName(errorName: string): string {
		return errorName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
	}
}
