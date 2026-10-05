import { RunwayProvider, MeshyProvider, ShotstackProvider, runBlenderRender } from './providers.js';
import { renderFreeFirst, localCreativeCapabilities, renderComfyUI } from './local.js';

export async function renderCreativeProject(project = {}, options = {}) {
  if (project?.qa && project.qa.passed === false) {
    throw new Error('not render-ready: creative project QA has not passed');
  }

  const strategy = String(options.strategy || process.env.CREATIVE_RENDER_STRATEGY || 'free-first').toLowerCase();

  if (strategy === 'free-first' || strategy === 'local' || strategy === 'self-hosted') {
    if (strategy === 'self-hosted' && options.comfyuiPrompt) {
      return renderComfyUI({
        prompt: options.comfyuiPrompt,
        workflow: options.comfyuiWorkflow,
        outputDir: options.outputDir,
        baseUrl: options.comfyuiBaseUrl
      });
    }
    try {
      return await renderFreeFirst({ project, options });
    } catch (error) {
      if (options.allowPaidFallback === true) return renderPaidProject(project, options);
      error.fallback = {
        available: 'self-hosted-comfyui',
        paid: ['runway', 'meshy', 'shotstack'],
        message: 'Free/local renderer failed; paid fallback was not enabled.'
      };
      throw error;
    }
  }

  if (strategy === 'paid') return renderPaidProject(project, options);
  throw new Error('unsupported creative render strategy: ' + strategy);
}

async function renderPaidProject(project, options = {}) {
  const type = String(project.type || '').toLowerCase();
  const spec = project.spec || {};
  if (type === 'video') {
    const p = options.videoProvider || new RunwayProvider(options.runway);
    const generation = await p.generateVideo({
      prompt: spec.brief?.description || 'professional brand video',
      promptImage: options.promptImage,
      ratio: spec.format?.ratio === '9:16' ? '768:1280' : '1280:768',
      duration: Math.min(15, Math.max(1, Number(spec.brief?.duration || 5))),
      model: options.videoModel || 'gen4.5'
    });
    if (options.shotstackTimeline) {
      const c = options.compositor || new ShotstackProvider(options.shotstack);
      return { generation, render: await c.render({ timeline: options.shotstackTimeline, output: options.shotstackOutput }) };
    }
    return { generation };
  }
  if (type === 'graphic' || type === 'image') {
    return {
      generation: await (options.imageProvider || new RunwayProvider(options.runway)).generateImage({
        prompt: spec.brief?.description || 'professional graphic design',
        ratio: '1360:768',
        model: options.imageModel || 'gen4_image',
        referenceImages: options.referenceImages || []
      })
    };
  }
  if (type === '3d' || type === 'three-d') {
    const generation = await (options.threeDProvider || new MeshyProvider(options.meshy)).generateTextTo3D({
      prompt: spec.brief?.description || 'professional 3D asset',
      model: options.threeDModel || 'latest',
      texture: options.texture !== false,
      enablePbr: options.enablePbr !== false,
      targetFormats: ['glb'],
      autoSize: true
    });
    if (options.blenderSceneFile) {
      return {
        generation,
        render: await runBlenderRender({
          sceneFile: options.blenderSceneFile,
          outputDir: options.outputDir || '/data',
          frame: options.frame || 1,
          binary: options.blenderBinary
        })
      };
    }
    return { generation };
  }
  throw new Error('unsupported creative render type: ' + type);
}

export function renderCapabilityMatrix(env = process.env) {
  return {
    ...localCreativeCapabilities(env),
    paidFallback: {
      strategy: 'explicit-opt-in',
      image: Boolean(env.RUNWAY_API_KEY),
      video: Boolean(env.RUNWAY_API_KEY),
      threeD: Boolean(env.MESHY_API_KEY),
      compositor: Boolean(env.SHOTSTACK_API_KEY)
    }
  };
}
