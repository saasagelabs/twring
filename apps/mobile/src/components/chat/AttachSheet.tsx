import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { ApiError } from '@/api/client';
import { apiErrorCopy } from '@/api/errors';
import { Sheet } from '@/components/Sheet';
import { font } from '@/theme/fonts';
import { usePalette, type } from '@/theme/tokens';
import { DOCUMENT_TYPES, fileCheck, type PreparedFile } from '@/threads/files';
import { newClientId } from '@/threads/outbox';
import { reportClientError } from '@/observability/sentry';
import { pickerQueue, pickerSelection, type PickerKind } from './picker-sequence';

export function AttachSheet({
  visible,
  count,
  onClose,
  onAdd,
  onNote,
}: {
  visible: boolean;
  count: number;
  onClose: () => void;
  onAdd: (files: PreparedFile[]) => void;
  onNote: (note: string) => void;
}) {
  const palette = usePalette();
  const remaining = 5 - count;
  // The choice waiting for the sheet to finish closing (iOS). Taken once: by onDismiss, or by the
  // fallback timer if iOS never reports the dismissal.
  const [pending] = useState(pickerQueue);
  const prepareImages = async (assets: ImagePicker.ImagePickerAsset[]) => {
    const files: PreparedFile[] = [];
    for (const asset of assets.slice(0, remaining)) {
      try {
        const longest = Math.max(asset.width, asset.height);
        const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
        if (longest > 2560)
          context.resize(
            asset.width >= asset.height
              ? { width: 2560, height: null }
              : { width: null, height: 2560 },
          );
        const rendered = await context.renderAsync();
        const result = await rendered.saveAsync({
          format: ImageManipulator.SaveFormat.JPEG,
          compress: 0.8,
        });
        const name = asset.fileName ? `${asset.fileName.replace(/\.[^.]+$/, '')}.jpg` : 'Photo.jpg';
        const file = {
          clientId: newClientId(),
          uri: result.uri,
          name,
          mimeType: 'image/jpeg',
          sizeBytes: new File(result.uri).size ?? 0,
          width: result.width,
          height: result.height,
        };
        const issue = fileCheck(file, count + files.length);
        if (issue) {
          new File(result.uri).delete();
          onNote(
            issue === 'too_many_files'
              ? 'You can attach up to 5 files.'
              : apiErrorCopy(new ApiError('http', issue)).message,
          );
        } else files.push(file);
      } catch (error) {
        reportClientError('attach_prepare_image', error);
        onNote("Couldn't prepare that photo. Try another one.");
      }
    }
    if (files.length) onAdd(files);
  };
  const launch = async (kind: PickerKind) => {
    if (remaining <= 0) return;
    try {
      if (kind === 'Camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          onNote('Allow the camera in Settings to take a photo.');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
        if (!result.canceled) await prepareImages(result.assets);
      } else if (kind === 'Photos') {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: remaining,
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        });
        if (!result.canceled) await prepareImages(result.assets);
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: [...DOCUMENT_TYPES],
          copyToCacheDirectory: true,
          multiple: true,
        });
        if (result.canceled) return;
        const files: PreparedFile[] = [];
        for (const asset of result.assets) {
          const file = {
            clientId: newClientId(),
            uri: asset.uri,
            name: asset.name,
            mimeType: asset.mimeType ?? '',
            sizeBytes: asset.size ?? new File(asset.uri).size ?? 0,
          };
          const issue = fileCheck(file, count + files.length);
          if (issue) {
            try {
              new File(asset.uri).delete();
            } catch {
              /* picker cache may already be gone */
            }
            onNote(
              issue === 'too_many_files'
                ? 'You can attach up to 5 files.'
                : apiErrorCopy(new ApiError('http', issue)).message,
            );
            continue;
          }
          files.push(file);
        }
        if (files.length) onAdd(files);
      }
    } catch (error) {
      reportClientError('attach_picker', error);
      onNote("Couldn't open files. Try again.");
    }
  };
  const launchPending = () => {
    const kind = pending.take();
    if (kind !== null) void launch(kind);
  };
  const choose = (kind: PickerKind) => {
    const decision = pickerSelection(Platform.OS, kind);
    pending.hold(decision.pending);
    onClose();
    if (decision.launchNow !== null) void launch(decision.launchNow);
    else setTimeout(launchPending, 700);
  };
  return (
    <Sheet visible={visible} title="Attach" onClose={onClose} onDismiss={launchPending}>
      {remaining === 0 ? (
        <Text style={[styles.note, { color: palette.textSecondary }]}>
          You can attach up to 5 files.
        </Text>
      ) : (
        (['Photos', 'Camera', 'File'] as const).map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityLabel={kind}
            onPress={() => choose(kind)}
            style={styles.choice}
          >
            <Text style={[styles.label, { color: palette.textPrimary }]}>{kind}</Text>
          </Pressable>
        ))
      )}
    </Sheet>
  );
}
const styles = StyleSheet.create({
  choice: { minHeight: 56, justifyContent: 'center', paddingHorizontal: 8 },
  label: { fontFamily: font.body, fontSize: type.body.fontSize },
  note: { fontFamily: font.body, fontSize: type.body.fontSize, paddingVertical: 12 },
});
