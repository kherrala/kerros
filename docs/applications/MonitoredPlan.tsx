import { useEffect, useState } from 'react';
import { FloorViewer } from '@kerros/viewer';
import type { ProjectDocument } from '@kerros/schema';
import type { StatusFeed, StatusReading } from '@kerros/viewer/host';
import '@kerros/viewer/styles.css';

export function MonitoredPlan({ project, feed }: { project: ProjectDocument; feed: StatusFeed }) {
  const [statuses, setStatuses] = useState<StatusReading[]>([]);
  useEffect(() => feed.subscribe(project, setStatuses), [feed, project]);
  return <FloorViewer project={project} statuses={statuses} controls />;
}
