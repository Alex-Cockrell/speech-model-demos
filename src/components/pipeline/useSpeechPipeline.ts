'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { PipelineController } from './controller';

/** One controller per mounted dashboard; panels receive slices of its snapshot plus its bound actions. */
export function useSpeechPipeline() {
  const [controller] = useState(() => new PipelineController());
  useEffect(() => controller.mount(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { snapshot, controller };
}
