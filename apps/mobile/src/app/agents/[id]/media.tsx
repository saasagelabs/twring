import type { MediaItem } from '@twring/contracts';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { twringApi } from '@/api';
import { shareAttachment } from '@/components/chat/Attachments';
import { ImageViewer } from '@/components/chat/ImageViewer';
import { ErrorNotice } from '@/components/ErrorNotice';
import { GhostButton } from '@/components/GhostButton';
import { goBack, Screen } from '@/components/Screen';
import { font } from '@/theme/fonts';
import { radius, space, type, usePalette } from '@/theme/tokens';
import { humanSize } from '@/threads/files';
import { useMedia } from '@/threads/media';

export const MEDIA_NOT_YET_COPY = 'Photos and files will show here once this server is updated.';
export const MEDIA_GONE_COPY = 'This agent is no longer here.';
export const MEDIA_EMPTY_COPY = 'No photos or files yet.';

type Source = { uri: string; headers?: Record<string, string> };

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function photoLabel(item: MediaItem, agentName: string): string {
  const date = shortDate(item.created_at);
  return item.direction === 'sent' ? `Photo you sent, ${date}` : `Photo from ${agentName}, ${date}`;
}

export function fileLine(item: MediaItem, agentName: string): string {
  const who = item.direction === 'sent' ? 'You sent' : `From ${agentName}`;
  return `${humanSize(item.size_bytes)} · ${who} · ${shortDate(item.created_at)}`;
}

/** Every photo and file in one agent's chat, newest first. Read only. */
export default function MediaScreen() {
  const palette = usePalette();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const agentName =
    typeof params.name === 'string' && params.name.trim() !== '' ? params.name : 'your agent';
  const media = useMedia(id);
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<MediaItem>();
  const [note, setNote] = useState('');

  const photos = media.items.filter((item) => item.mime_type.startsWith('image/'));
  const files = media.items.filter((item) => !item.mime_type.startsWith('image/'));

  // Photos already asked for (answered or in flight); a new page never asks again.
  const requested = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Same signed source the chat uses for its photos; resolved once per photo, each on its own.
  const missing = photos
    .filter((item) => sources[item.id] === undefined && !failed[item.id])
    .map((item) => item.id)
    .join(',');
  useEffect(() => {
    if (missing === '') return;
    const api = twringApi();
    if (!api?.fileSource) return;
    const fileSource = api.fileSource.bind(api);
    for (const fileId of missing.split(',')) {
      if (requested.current.has(fileId)) continue;
      requested.current.add(fileId);
      fileSource(id, fileId).then(
        (source) => {
          if (alive.current) setSources((previous) => ({ ...previous, [fileId]: source }));
        },
        () => {
          if (alive.current) setFailed((previous) => ({ ...previous, [fileId]: true }));
        },
      );
    }
  }, [id, missing]);

  const openFile = async (item: MediaItem) => {
    try {
      const api = twringApi();
      if (api) await shareAttachment(api, id, item);
      setNote('');
    } catch {
      setNote("Couldn't open that file. Tap to try again.");
    }
  };

  let body;
  if (media.status === 'loading') {
    body = <ActivityIndicator color={palette.accent} accessibilityLabel="Loading" />;
  } else if (media.status === 'gone') {
    body = (
      <>
        <Text style={[type.body, { color: palette.textSecondary }]}>{MEDIA_GONE_COPY}</Text>
        <GhostButton label="Back" onPress={goBack} />
      </>
    );
  } else if (media.status === 'not_yet') {
    body = <Text style={[type.body, { color: palette.textSecondary }]}>{MEDIA_NOT_YET_COPY}</Text>;
  } else if (media.status === 'error' && media.error !== undefined) {
    body = <ErrorNotice error={media.error} onRetry={media.refresh} />;
  } else if (media.items.length === 0) {
    body = <Text style={[type.body, { color: palette.textSecondary }]}>{MEDIA_EMPTY_COPY}</Text>;
  } else {
    body = (
      <>
        {photos.length > 0 && (
          <View style={styles.grid}>
            {photos.map((item) => {
              const source = sources[item.id];
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={photoLabel(item, agentName)}
                  onPress={() => setViewer(item)}
                  style={[styles.tile, { backgroundColor: palette.surfaceRaised }]}
                >
                  {source && !failed[item.id] ? (
                    <Image
                      source={source}
                      cachePolicy="memory"
                      contentFit="cover"
                      style={StyleSheet.absoluteFill}
                      onError={() => setFailed((previous) => ({ ...previous, [item.id]: true }))}
                    />
                  ) : (
                    <Text style={[styles.caption, { color: palette.textSecondary }]}>
                      {failed[item.id] ? "Couldn't load" : 'Loading…'}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
        {files.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${fileLine(item, agentName)}`}
            accessibilityHint="Opens or shares the file"
            onPress={() => void openFile(item)}
            style={[styles.file, { backgroundColor: palette.surfaceRaised }]}
          >
            <Text style={[styles.name, { color: palette.textPrimary }]} numberOfLines={2}>
              {item.name}
            </Text>
            <Text style={[styles.caption, { color: palette.textSecondary }]}>
              {fileLine(item, agentName)}
            </Text>
          </Pressable>
        ))}
        {!!note && <Text style={[styles.caption, { color: palette.danger }]}>{note}</Text>}
        {media.moreError !== undefined && (
          <ErrorNotice
            error={media.moreError}
            onRetry={media.hasMore ? media.loadMore : media.refresh}
          />
        )}
        {media.loadingMore ? (
          <ActivityIndicator color={palette.accent} accessibilityLabel="Loading older" />
        ) : (
          media.hasMore &&
          media.moreError === undefined && (
            <GhostButton label="Show older" onPress={media.loadMore} />
          )
        )}
      </>
    );
  }

  return (
    <Screen back title="Photos and files" refreshing={media.refreshing} onRefresh={media.refresh}>
      <View style={styles.body}>{body}</View>
      <ImageViewer
        key={viewer?.id ?? 'closed'}
        file={viewer}
        source={viewer && sources[viewer.id]}
        onClose={() => setViewer(undefined)}
        onShare={() => {
          const api = twringApi();
          return api && viewer
            ? shareAttachment(api, id, viewer)
            : Promise.reject(new Error('File unavailable'));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md },
  tile: {
    width: 104,
    height: 104,
    borderRadius: radius.xs,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  file: {
    minHeight: 56,
    borderRadius: radius.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    justifyContent: 'center',
  },
  name: { fontFamily: font.bodyEmphasis, fontSize: type.body.fontSize },
  caption: { fontFamily: font.caption, fontSize: type.caption.fontSize },
});
