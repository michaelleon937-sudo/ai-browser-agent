import { describe, expect, it } from 'vitest';
import { buildVisualQAReport, createVisualQAMatrix, runVisualQA, queueVisualRepair, VIEWPORTS, VISUAL_QA_VERSION } from '../../creative-engine/visual-qa.js';

describe('Professional Creative Visual QA Engine', () => {
  it('passes clean evidence', () => {
    const result = runVisualQA({viewport:'mobile'});
    expect(result.passed).toBe(true);
    expect(result.version).toBe(VISUAL_QA_VERSION);
  });
  it('blocks overflow and failed checks', () => {
    const result = runVisualQA({viewport:'desktop', overflow:true, contrast:false});
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('layout overflow detected');
    expect(result.failures).toContain('contrast check failed');
  });
  it('builds the full responsive viewport matrix', () => {
    const matrix = createVisualQAMatrix({});
    expect(matrix).toHaveLength(Object.keys(VIEWPORTS).length);
    expect(matrix.map(x=>x.viewport)).toEqual(Object.keys(VIEWPORTS));
  });
  it('queues repair only when visual QA fails', () => {
    const pass = queueVisualRepair({passed:true});
    expect(pass.queued).toBe(false);
    const fail = queueVisualRepair({passed:false, failures:['desktop: layout overflow detected']});
    expect(fail.queued).toBe(true);
    expect(fail.maxAttempts).toBe(3);
  });
  it('reports viewport-scoped failures', () => {
    const report = buildVisualQAReport({name:'Test Creative'}, {mobile:{overflow:true}});
    expect(report.passed).toBe(false);
    expect(report.repairRequired).toBe(true);
    expect(report.failures[0]).toContain('mobile:');
  });
});
