import { describe, it, expect } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCreativeProject, renderCreativeProject } from '../../creative-engine/index.js';
import { buildDeliveryPackage } from '../../creative-engine/delivery.js';

describe('professional creative actual render E2E', () => {
  it('renders a real PNG and MP4 locally with no paid provider', async () => {
    const dir=await mkdtemp(path.join(tmpdir(),'creative-e2e-'));
    const imageProject=createCreativeProject({type:'graphic',name:'E2E Luxury Image',description:'Luxury product campaign',industry:'luxury'});
    const image=await renderCreativeProject(imageProject,{outputDir:dir});
    expect(image.provider).toBe('free-local-browser'); expect((await stat(image.path)).size).toBeGreaterThan(0);
    const videoProject=createCreativeProject({type:'video',name:'E2E Luxury Video',description:'Luxury product campaign',industry:'luxury'});
    const video=await renderCreativeProject(videoProject,{outputDir:dir,scenes:3,fps:8});
    expect(video.provider).toBe('free-local-browser+ffmpeg'); expect((await stat(video.path)).size).toBeGreaterThan(0);
  });
  it('runs the real Blender procedural renderer with the CI-installed Blender binary', async () => {
    const dir=await mkdtemp(path.join(tmpdir(),'creative-3d-e2e-'));
    const project=createCreativeProject({type:'3d',name:'E2E 3D Hero',description:'Luxury product visualization',industry:'luxury'});
    const result=await renderCreativeProject(project,{outputDir:dir,blenderBinary:process.env.BLENDER_BIN||'blender'});
    expect(result.provider).toBe('free-local-blender');
    for(const file of result.files) expect((await stat(file)).size).toBeGreaterThan(0);
  });
  it('blocks rendering unless QA has passed', async () => {
    const project=createCreativeProject({type:'graphic',name:'Blocked',description:'test',industry:'corporate'});
    await expect(renderCreativeProject({...project,qa:{passed:false}},{outputDir:await mkdtemp(path.join(tmpdir(),'creative-gate-'))})).rejects.toThrow('QA must pass before rendering');
    await expect(renderCreativeProject({...project,qa:undefined},{outputDir:await mkdtemp(path.join(tmpdir(),'creative-gate-missing-'))})).rejects.toThrow('QA must pass before rendering');
  });
  it('requires a rendered output for delivery/export verification', async () => {
    const project=createCreativeProject({type:'graphic',name:'Delivery',description:'test',industry:'corporate'});
    const blocked=await buildDeliveryPackage(project,{licensesAttached:true,formats:['png']}); expect(blocked.status).toBe('BLOCKED');
    const dir=await mkdtemp(path.join(tmpdir(),'creative-delivery-')); const rendered=await renderCreativeProject(project,{outputDir:dir});
    const ready=await buildDeliveryPackage(project,{licensesAttached:true,formats:['png'],renderResult:rendered});
    expect(ready.status).toBe('READY_FOR_EXPORT'); expect(ready.exportVerification.passed).toBe(true);
  });
});
