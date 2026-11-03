import type { Attachment } from '@twring/contracts';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TwringApi } from '@/api/client';
import { twringApi } from '@/api';
import { font } from '@/theme/fonts';
import { usePalette } from '@/theme/tokens';
import { humanSize, typeLabel, type PreparedFile } from '@/threads/files';
import { ImageViewer } from './ImageViewer';

export async function shareAttachment(
  api: Pick<TwringApi, 'fileSource'>,
  agentId: string,
  file: Attachment,
): Promise<void> {
  if (!api.fileSource) throw new Error('File source unavailable');
  const source = await api.fileSource(agentId, file.id);
  const safeName = [...file.name]
    .map((character) =>
      character === '/' || character === '\\' || character.charCodeAt(0) < 32 ? '_' : character,
    )
    .join('');
  const destination = new File(Paths.cache, `${file.id}-${safeName}`);
  try {
    const downloaded = await File.downloadFileAsync(source.uri, destination, {
      headers: source.headers,
      idempotent: true,
    });
    await Sharing.shareAsync(downloaded.uri, { mimeType: file.mime_type, dialogTitle: file.name });
  } finally {
    try {
      destination.delete();
    } catch {
      /* cache may be removed already */
    }
  }
}

export function Attachments({
  agentId,
  files,
  pending = false,
}: {
  agentId: string;
  files: Attachment[] | PreparedFile[];
  pending?: boolean;
}) {
  const palette = usePalette();
  const [sources, setSources] = useState<
    Record<string, { uri: string; headers?: Record<string, string> }>
  >({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [version, setVersion] = useState(0);
  const [viewer, setViewer] = useState<Attachment>();
  const [note, setNote] = useState('');
  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    const api = twringApi();
    if (!api?.fileSource) return;
    void Promise.all(
      files
        .filter((file): file is Attachment => !('clientId' in file))
        .map(async (file) => [file.id, await api.fileSource!(agentId, file.id)] as const),
    )
      .then((entries) => {
        if (!cancelled) setSources(Object.fromEntries(entries));
      })
      .catch(() => {
        if (!cancelled) {
          setNote("Couldn't load files. Tap to try again.");
          setFailed(
            Object.fromEntries(
              files
                .filter((file): file is Attachment => !('clientId' in file))
                .map((file) => [file.id, true]),
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, files, pending]);
  if (!files.length) return null;
  const imageCount = files.filter((file) =>
    ('clientId' in file ? file.mimeType : file.mime_type).startsWith('image/'),
  ).length;
  const open = async (file: Attachment) => {
    if (file.mime_type.startsWith('image/')) {
      setViewer(file);
      return;
    }
    try {
      const api = twringApi();
      if (api) await shareAttachment(api, agentId, file);
      setNote('');
    } catch {
      setNote("Couldn't open that file. Tap to try again.");
    }
  };
  const retryImage = async (file: Attachment) => {
    try {
      const api = twringApi();
      if (!api?.fileSource) throw new Error('File source unavailable');
      const source = await api.fileSource(agentId, file.id);
      setSources((previous) => ({ ...previous, [file.id]: source }));
      setFailed((previous) => ({ ...previous, [file.id]: false }));
      setVersion((current) => current + 1);
      setNote('');
    } catch {
      setFailed((previous) => ({ ...previous, [file.id]: true }));
    }
  };
  return (
    <View style={styles.wrap}>
      <View style={[styles.grid, imageCount > 1 && styles.twoColumns]}>
        {files.map((entry) => {
          const isPending = 'clientId' in entry;
          const id = isPending ? entry.clientId : entry.id;
          const name = entry.name;
          const mimeType = isPending ? entry.mimeType : entry.mime_type;
          const size = isPending ? entry.sizeBytes : entry.size_bytes;
          const source = isPending ? { uri: entry.uri } : sources[id];
          const image = mimeType.startsWith('image/');
          const width = isPending ? entry.width : entry.width;
          const height = isPending ? entry.height : entry.height;
          const ratio = width && height ? width / height : 1;
          return image ? (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`Photo, ${name}`}
              onPress={() => {
                if (isPending) return;
                if (failed[id]) {
                  void retryImage(entry);
                } else void open(entry);
              }}
              style={[
                styles.tile,
                {
                  width: imageCount > 1 ? 108 : Math.min(240, 180 * ratio),
                  height: imageCount > 1 ? 108 : Math.min(240, 180 / ratio),
                  backgroundColor: palette.surfaceRaised,
                },
              ]}
            >
              {source && !failed[id] ? (
                <Image
                  key={`${id}-${version}`}
                  source={source}
                  cachePolicy="memory"
                  contentFit="cover"
                  style={StyleSheet.absoluteFill}
                  onError={() => setFailed((prev) => ({ ...prev, [id]: true }))}
                />
              ) : (
                <Text style={[styles.error, { color: palette.textSecondary }]}>
                  {failed[id] ? "Couldn't load" : 'Loading…'}
                </Text>
              )}
              {pending && <ActivityIndicator style={styles.spinner} color={palette.accent} />}
            </Pressable>
          ) : (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${typeLabel(mimeType)}, ${humanSize(size)}`}
              disabled={isPending}
              onPress={() => {
                if (!isPending) void open(entry);
              }}
              style={[styles.chip, { backgroundColor: palette.surfaceRaised }]}
            >
              <Text style={[styles.document, { color: palette.textPrimary }]} numberOfLines={1}>
                ▤ {name}
              </Text>
              <Text style={[styles.size, { color: palette.textSecondary }]}>{humanSize(size)}</Text>
              {pending && <ActivityIndicator color={palette.accent} />}
            </Pressable>
          );
        })}
      </View>
      {!!note && <Text style={[styles.error, { color: palette.danger }]}>{note}</Text>}
      <ImageViewer
        key={viewer?.id ?? 'closed'}
        file={viewer}
        source={viewer && sources[viewer.id]}
        onClose={() => setViewer(undefined)}
        onShare={() => {
          const api = twringApi();
          return api && viewer
            ? shareAttachment(api, agentId, viewer)
            : Promise.reject(new Error('File unavailable'));
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { marginBottom: 8 },
  grid: { gap: 6 },
  twoColumns: { flexDirection: 'row', flexWrap: 'wrap', maxWidth: 222 },
  tile: { borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  spinner: { position: 'absolute', right: 6, bottom: 6 },
  error: { fontFamily: font.body, fontSize: 12 },
  chip: {
    minHeight: 52,
    minWidth: 160,
    borderRadius: 10,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  document: { fontFamily: font.bodyEmphasis, fontSize: 13 },
  size: { fontFamily: font.caption, fontSize: 11 },
});
