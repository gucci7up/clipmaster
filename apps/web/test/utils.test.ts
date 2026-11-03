import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatTimecode } from '../src/lib/utils';

describe('formato', () => {
  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65.4)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
  it('formatTimecode no produce 60 segundos', () => {
    expect(formatTimecode(0)).toBe('00:00.0');
    expect(formatTimecode(59.96)).toBe('01:00.0');
    expect(formatTimecode(75.25)).toBe('01:15.3');
  });
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});
