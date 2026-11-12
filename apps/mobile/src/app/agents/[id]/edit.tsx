import { agentNameSchema, type Agent } from '@twring/contracts';
import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { canEditAgent, VIEW_ONLY_AGENT_NOTE } from '@/agents/shared';
import { apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { Avatar } from '@/components/Avatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Field } from '@/components/Field';
import { GhostButton } from '@/components/GhostButton';
import { PrimaryButton } from '@/components/PrimaryButton';
import { goBack, Screen } from '@/components/Screen';
import { useResource } from '@/hooks/useResource';
import { space, type, usePalette, radius } from '@/theme/tokens';

type PhotoChange = { kind: 'upload'; uri: string } | { kind: 'remove' } | undefined;

export default function EditAgentScreen() {
  const { id: paramId } = useLocalSearchParams<{ id: string }>();
  const id = typeof paramId === 'string' ? paramId : '';
  const palette = usePalette();
  const [name, setName] = useState<string | undefined>();
  const [photo, setPhoto] = useState<PhotoChange>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorCopy | undefined>();
  const load = useCallback(
    async (signal: AbortSignal): Promise<Agent> => {
      const api = twringApi();
      if (!api) throw new Error('not configured');
      return api.getAgent(id, signal);
    },
    [id],
  );
  const agent = useResource(load);
  const current = agent.data;
  const editedName = name ?? current?.name ?? '';
  const validName = agentNameSchema.safeParse(editedName);
  const changed =
    current !== undefined && (editedName.trim() !== current.name || photo !== undefined);

  async function choosePhoto() {
    try {
      const choice = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (choice.canceled) return;
      const asset = choice.assets[0];
      if (!asset) return;
      const side = Math.min(asset.width, asset.height);
      const manipulator = ImageManipulator.ImageManipulator.manipulate(asset.uri);
      manipulator.crop({
        originX: Math.floor((asset.width - side) / 2),
        originY: Math.floor((asset.height - side) / 2),
        width: side,
        height: side,
      });
      manipulator.resize({ width: 512, height: 512 });
      const rendered = await manipulator.renderAsync();
      const result = await rendered.saveAsync({
        format: ImageManipulator.SaveFormat.JPEG,
        compress: 0.8,
      });
      if ((new File(result.uri).size ?? 0) > 300 * 1024) {
        new File(result.uri).delete();
        setError({ message: 'This photo is too large. Choose another photo.', retryable: false });
        return;
      }
      setPhoto({ kind: 'upload', uri: result.uri });
      setError(undefined);
    } catch (reason) {
      setError(apiErrorCopy(reason));
    }
  }

  async function save() {
    if (!current || !validName.success || !changed || saving) return;
    const api = twringApi();
    if (!api) {
      setError(apiErrorCopy(new Error('not configured')));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      if (validName.data !== current.name) await api.updateAgent(id, { name: validName.data });
      if (photo?.kind === 'upload') await api.setAgentAvatar(id, photo.uri);
      if (photo?.kind === 'remove') await api.removeAgentAvatar(id);
      goBack();
    } catch (reason) {
      setError(apiErrorCopy(reason));
    } finally {
      setSaving(false);
    }
  }

  if (current !== undefined && !canEditAgent(current)) {
    return (
      <Screen back title="Edit agent">
        <Text style={[type.body, { color: palette.textSecondary }]}>{VIEW_ONLY_AGENT_NOTE}</Text>
      </Screen>
    );
  }

  return (
    <Screen
      back
      title="Edit agent"
      footer={
        <PrimaryButton
          label="Save"
          disabled={saving || !changed || !validName.success}
          onPress={() => void save()}
        />
      }
    >
      {agent.data === undefined ? (
        agent.error ? (
          <ErrorNotice error={agent.error} onRetry={() => agent.reload()} />
        ) : (
          <ActivityIndicator accessibilityLabel="Loading agent" color={palette.textSecondary} />
        )
      ) : (
        <View style={styles.content}>
          <View style={styles.photo}>
            {photo?.kind === 'upload' ? (
              <Image source={{ uri: photo.uri }} style={styles.preview} />
            ) : (
              <Avatar
                id={id}
                name={editedName}
                avatarVersion={photo?.kind === 'remove' ? undefined : current?.avatar_version}
                size={112}
              />
            )}
            <GhostButton
              label="Change photo"
              disabled={saving}
              onPress={() => void choosePhoto()}
            />
            {(photo?.kind === 'upload' ||
              (current?.avatar_version !== undefined && photo?.kind !== 'remove')) && (
              <GhostButton
                label="Remove photo"
                tone="danger"
                disabled={saving}
                onPress={() => setPhoto(current?.avatar_version ? { kind: 'remove' } : undefined)}
              />
            )}
          </View>
          <Field
            label="Name"
            value={editedName}
            maxLength={60}
            onChangeText={setName}
            autoCapitalize="words"
            autoCorrect={false}
            error={validName.success ? undefined : 'Enter a name of up to 60 characters.'}
          />
          {error && <ErrorNotice error={error} />}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.lg },
  photo: { alignItems: 'center', gap: space.sm },
  preview: { width: 112, height: 112, borderRadius: radius.pill },
});
