// Adapter for unchanged Exercism problem-specifications canonical cases.
// Usage: node long-task-grader.mjs <candidate-directory> <canonical-data-directory>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function flattenCases(cases) {
  return cases.flatMap((entry) => (entry.cases ? flattenCases(entry.cases) : [entry]));
}
const computations = new Map([
  ['inputs[0] + 1', (v) => v[0] + 1],
  ['inputs[0] - 1', (v) => v[0] - 1],
  ['inputs[0] * 2', (v) => v[0] * 2],
  ['inputs[0] * 30', (v) => v[0] * 30],
  ['inputs[0] + inputs[1]', (v) => v[0] + v[1]],
  ['inputs[0] - inputs[1]', (v) => v[0] - v[1]],
  ['inputs[0] * inputs[1]', (v) => v[0] * v[1]],
  ['inputs[0] + inputs[1] * 10', (v) => v[0] + v[1] * 10],
  ['if inputs[0] < 3 then 111 else 222', (v) => (v[0] < 3 ? 111 : 222)],
]);
function reactCase(module, input) {
  const cells = new Map(),
    callbacks = new Map();
  for (const cell of input.cells) {
    if (cell.type === 'input') cells.set(cell.name, new module.InputCell(cell.initial_value));
    else {
      const compute = computations.get(cell.compute_function);
      assert.ok(compute, 'Unsupported canonical computation: ' + cell.compute_function);
      cells.set(
        cell.name,
        new module.ComputeCell(
          cell.inputs.map((name) => cells.get(name)),
          compute,
        ),
      );
    }
  }
  for (const operation of input.operations) {
    const cell = cells.get(operation.cell);
    switch (operation.type) {
      case 'expect_cell_value':
        assert.equal(cell.value, operation.value);
        break;
      case 'add_callback': {
        const values = [];
        const fn = (value) => values.push(value);
        callbacks.set(operation.name, { fn, values });
        cell.addCallback(fn);
        break;
      }
      case 'remove_callback':
        cell.removeCallback(callbacks.get(operation.name).fn);
        break;
      case 'set_value': {
        for (const callback of callbacks.values()) callback.values.length = 0;
        cell.setValue(operation.value);
        for (const [name, value] of Object.entries(operation.expect_callbacks ?? {}))
          assert.deepEqual(callbacks.get(name).values, [value]);
        for (const name of operation.expect_callbacks_not_to_be_called ?? [])
          assert.deepEqual(callbacks.get(name).values, []);
        break;
      }
      default:
        throw new Error('Unsupported canonical operation: ' + operation.type);
    }
  }
}

export async function grade(candidate, canonical) {
  const results = [];
  for (const [name, file] of [
    ['forth', 'forth.mjs'],
    ['react', 'react.mjs'],
    ['sgf-parsing', 'sgf.mjs'],
  ]) {
    const cases = flattenCases(JSON.parse(readFileSync(join(canonical, name, 'canonical-data.json'), 'utf8')).cases);
    let module, importError;
    try {
      module = await import(pathToFileURL(join(candidate, file)).href);
    } catch (error) {
      importError = error;
    }
    for (const entry of cases) {
      try {
        if (importError) throw importError;
        const execute = () => {
          if (name === 'forth') {
            const evaluate = (instructions) => {
              const forth = new module.Forth();
              for (const instruction of instructions) forth.evaluate(instruction);
              return forth.stack;
            };
            if (entry.property === 'evaluateBoth')
              return [evaluate(entry.input.instructionsFirst), evaluate(entry.input.instructionsSecond)];
            assert.equal(entry.property, 'evaluate', 'Unsupported canonical Forth property.');
            return evaluate(entry.input.instructions);
          }
          if (name === 'sgf-parsing') return module.parse(entry.input.encoded);
          return reactCase(module, entry.input);
        };
        if (entry.expected.error) assert.throws(execute, (error) => error.message === entry.expected.error);
        else {
          const value = execute();
          if (name !== 'react') assert.deepEqual(value, entry.expected);
        }
        results.push({ exercise: name, uuid: entry.uuid, description: entry.description, passed: true });
      } catch (error) {
        results.push({
          exercise: name,
          uuid: entry.uuid,
          description: entry.description,
          passed: false,
          error: String(error.message).slice(0, 1200),
        });
      }
    }
  }
  return { total: results.length, passed: results.filter((r) => r.passed).length, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await grade(resolve(process.argv[2]), resolve(process.argv[3]));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.passed === result.total && result.total > 0 ? 0 : 1;
}
