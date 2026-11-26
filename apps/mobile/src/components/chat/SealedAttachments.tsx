import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  displayFileName,
  isSealedDocument,
  isSealedPhoto,
  type SealedFileEntry,
} from '@/e2e/sealed-files';
import { font } from '@/theme/fonts';
import { usePalette, radius, type } from '@/theme/tokens';
import { humanSize } from '@/threads/files';
import { ImageViewer } from './ImageViewer';

export const COULDNT_OPEN_FILE = "Couldn't open this file";

type Opened = { uri: string } | { error: 'couldnt_open' };
type State = Opened | 'loading';

/**
 * The photos and files of a private message (ADR-045). Each is downloaded as an opaque blob,
 * opened on this phone and kept in the cache (`openSealedFile`); a blob that does not open shows
 * a plain line and a retry, never other bytes. Names come from the computer, so they are cleaned.
 */
export function SealedAttachments({
  files,
  open,
}: {
  files: SealedFileEntry[];
  open: (file: SealedFileEntry) => Promise<Opened>;
}) {
  const palette = usePalette();
  const [states, setStates] = useState<Record<string, State>>({});
  const [viewer, setViewer] = useState<{ id: string; name: string; uri: string }>();
  const set = useCallback(
    (file: SealedFileEntry, state: State) =>
      setStates((previous) => ({ ...previous, [file.file_id]: state })),
    [],
  );
  const share = useCallback(
    async (file: SealedFileEntry, uri: string) => {
      try {
        await Sharing.shareAsync(uri, {
          mimeType: file.mime,
          dialogTitle: displayFileName(file.name),
        });
      } catch {
        set(file, { error: 'couldnt_open' });
      }
    },
    [set],
  );
  /** Opens one file; a document is shared as soon as it is ready when the person asked for it. */
  const load = useCallback(
    (file: SealedFileEntry, thenShare: boolean) => {
      set(file, 'loading');
      void open(file)
        .catch((): Opened => ({ error: 'couldnt_open' }))
        .then((result) => {
          set(file, result);
          if (thenShare && 'uri' in result) void share(file, result.uri);
        });
    },
    [open, set, share],
  );
  // Photos open as the message appears; documents wait for a tap (nothing downloads for a row).
  useEffect(() => {
    let live = true;
    for (const file of files)
      if (isSealedPhoto(file.mime))
        void open(file)
          .catch((): Opened => ({ error: 'couldnt_open' }))
          .then((result) => live && set(file, result));
    return () => {
      live = false;
    };
  }, [files, open, set]);

  const photos = files.filter((file) => isSealedPhoto(file.mime));

  return (
    <View style={styles.wrap}>
      <View style={[styles.grid, photos.length > 1 && styles.twoColumns]}>
        {files.map((file) => {
          const name = displayFileName(file.name);
          const state = states[file.file_id];
          const uri =
            state !== undefined && state !== 'loading' && 'uri' in state ? state.uri : undefined;
          if (state !== undefined && state !== 'loading' && 'error' in state)
            return (
              <Pressable
                key={file.file_id}
                accessibilityRole="button"
                accessibilityLabel={`${COULDNT_OPEN_FILE}. Tap to try again.`}
                onPress={() => load(file, !isSealedPhoto(file.mime) && isSealedDocument(file.mime))}
                style={[styles.chip, { backgroundColor: palette.surfaceRaised }]}
              >
                <Text style={[styles.error, { color: palette.danger }]}>{COULDNT_OPEN_FILE}</Text>
              </Pressable>
            );
          if (isSealedPhoto(file.mime)) {
            const side = photos.length > 1 ? 108 : 180;
            return (
              <Pressable
                key={file.file_id}
                accessibilityRole="button"
                accessibilityLabel={`Photo, ${name}`}
                disabled={uri === undefined}
                onPress={() => uri && setViewer({ id: file.file_id, name, uri })}
                style={[
                  styles.tile,
                  { width: side, height: side, backgroundColor: palette.surfaceRaised },
                ]}
              >
                {uri !== undefined ? (
                  <Image
                    source={{ uri }}
                    cachePolicy="memory"
                    contentFit="cover"
                    style={StyleSheet.absoluteFill}
                    onError={() => set(file, { error: 'couldnt_open' })}
                  />
                ) : (
                  <Text style={[styles.error, { color: palette.textSecondary }]}>Loading…</Text>
                )}
              </Pressable>
            );
          }
          if (isSealedDocument(file.mime))
            return (
              <Pressable
                key={file.file_id}
                accessibilityRole="button"
                accessibilityLabel={`${name}, ${humanSize(file.size)}. Tap to open.`}
                disabled={state === 'loading'}
                onPress={() => (uri !== undefined ? void share(file, uri) : load(file, true))}
                style={[styles.chip, { backgroundColor: palette.surfaceRaised }]}
              >
                <Text style={[styles.document, { color: palette.textPrimary }]} numberOfLines={1}>
                  ▤ {name}
                </Text>
                <Text style={[styles.size, { color: palette.textSecondary }]}>
                  {humanSize(file.size)}
                </Text>
              </Pressable>
            );
          // Any other type is named, never opened.
          return (
            <View
              key={file.file_id}
              accessible
              accessibilityLabel={`File: ${name}`}
              style={[styles.chip, { backgroundColor: palette.surfaceRaised }]}
            >
              <Text style={[styles.document, { color: palette.textPrimary }]} numberOfLines={1}>
                File: {name}
              </Text>
            </View>
          );
        })}
      </View>
      <ImageViewer
        key={viewer?.id ?? 'closed'}
        file={viewer && { id: viewer.id, name: viewer.name }}
        source={viewer && { uri: viewer.uri }}
        onClose={() => setViewer(undefined)}
        onShare={() =>
          viewer
            ? Sharing.shareAsync(viewer.uri, { dialogTitle: viewer.name })
            : Promise.reject(new Error('File unavailable'))
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 8 },
  grid: { gap: 6 },
  twoColumns: { flexDirection: 'row', flexWrap: 'wrap', maxWidth: 222 },
  tile: {
    borderRadius: radius.xs,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { fontFamily: font.body, fontSize: type.caption.fontSize },
  chip: {
    minHeight: 52,
    minWidth: 160,
    borderRadius: radius.xs,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  document: { fontFamily: font.bodyEmphasis, fontSize: type.caption.fontSize },
  size: { fontFamily: font.caption, fontSize: type.microLabel.fontSize },
});
