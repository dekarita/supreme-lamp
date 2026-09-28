#!/usr/bin/env node
// F45 S1: parse JSX rather than grepping comments/strings. CRLF-safe at read.
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const parse = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

export function readLock(text, name) {
  let values;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
      let value = node.initializer;
      if (value && ts.isAsExpression(value)) value = value.expression;
      if (!value || !ts.isArrayLiteralExpression(value) || !value.elements.every(ts.isStringLiteral)) {
        throw new Error(`${name}: lock must be a literal string array`);
      }
      values = value.elements.map((entry) => entry.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse('lock.ts', text.replace(/\r\n?/g, '\n')));
  if (!values?.length) throw new Error(`${name}: missing or empty lock`);
  return values;
}

export function checkLocks(ids, classes, parent) {
  const errors = [];
  if (parent.length !== 219 || new Set(parent).size !== 219) errors.push('parent lock must contain 219 unique IDs');
  const all = [...ids, ...classes];
  if (new Set(all).size !== all.length) errors.push('duplicate fx lock entry');
  for (const value of all) {
    if (!/^fx-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) errors.push(`not namespaced: ${value}`);
    if (parent.some((p) => p.replace(/^[#.]/, '') === value)) errors.push(`F38 collision: ${value}`);
  }
  return errors;
}

export function checkSource(text, path, ids, classes, seen = new Map()) {
  const errors = [];
  const source = parse(path, text.replace(/\r\n?/g, '\n'));
  const explorer = /(?:^|\/)components\/explorer\//.test(path) || /(?:^|\/)pages\/Files\.tsx$/.test(path);
  const report = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push(`${path}:${line + 1}: ${message}`);
  };
  const literal = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
    if (node && ts.isJsxExpression(node)) return literal(node.expression);
    return undefined;
  };
  const visit = (node) => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (name === 'id') {
        const value = literal(node.initializer);
        if (value === undefined && explorer) report(node, 'dynamic id forbidden; use a frozen literal on the adapter');
        if (value !== undefined && (explorer || value.startsWith('fx-'))) {
          if (!ids.includes(value)) report(node, `unregistered Explorer id: ${value}`);
          if (seen.has(value)) report(node, `duplicate Explorer id: ${value} (first in ${seen.get(value)})`);
          seen.set(value, path);
        }
      }
      if (name === 'className' || name === 'class') {
        const inspect = (part) => {
          if (ts.isStringLiteral(part) || ts.isNoSubstitutionTemplateLiteral(part)) {
            for (const value of part.text.split(/\s+/)) {
              if (value.startsWith('fx-') && !classes.includes(value)) report(part, `unregistered Explorer class: ${value}`);
            }
          }
          if (ts.isTemplateExpression(part) && part.getText(source).includes('fx-')) {
            report(part, 'dynamic fx class forbidden; use a frozen literal');
          }
          ts.forEachChild(part, inspect);
        };
        if (node.initializer) inspect(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

export function checkProject(root = process.cwd()) {
  const lock = read(join(root, 'src/components/explorer/regression-fx-ids.ts'));
  const ids = readLock(lock, 'REGRESSION_FX_IDS');
  const classes = readLock(lock, 'REGRESSION_FX_CLASSES');
  const parent = readLock(read(join(root, 'src/lib/regression-ids.ts')), 'REGRESSION_IDS');
  const errors = checkLocks(ids, classes, parent);
  const seen = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === '__tests__') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx')) errors.push(...checkSource(read(path), relative(root, path).replaceAll('\\', '/'), ids, classes, seen));
    }
  };
  walk(join(root, 'src'));
  return { errors, ids, classes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { errors, ids, classes } = checkProject();
    if (errors.length) throw new Error(errors.join(' | '));
    console.log(`[F45 S1] fx-ids PASS: ${ids.length} IDs + ${classes.length} class; F38 collision-free (219). DOM coverage begins at S5.`);
  } catch (error) {
    const message = String(error.message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=F45 S1 fx-ids::${message}`);
    process.exitCode = 1;
  }
}
