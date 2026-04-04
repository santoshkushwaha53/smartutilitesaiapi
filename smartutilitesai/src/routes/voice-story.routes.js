import express from 'express';
import {
  buildSafeFileName,
  generateSpeechClipWithOpenAI,
  tryMergeAudioBuffers,
} from '../services/openai-voice.service.js';

const router = express.Router();

router.post('/generate', async (req, res) => {
  try {
    const {
      title = 'Voice Story Output',
      mode = 'single',
      sections = [],
      outputFormat = 'mp3',
      provider = 'openai',
      providerModel = 'gpt-4o-mini-tts',
    } = req.body ?? {};

    if (provider !== 'openai') {
      return res.status(400).json({ error: 'Only provider=openai is supported by this sample route.' });
    }

    if (!Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'At least one section is required.' });
    }

    if (!['mp3', 'wav', 'opus'].includes(outputFormat)) {
      return res.status(400).json({ error: 'Unsupported outputFormat. Use mp3, wav, or opus.' });
    }

    const cleanedSections = sections
      .map((section, index) => ({
        id: section.id || `section-${index + 1}`,
        label: String(section.label || `Section ${index + 1}`),
        text: String(section.text || '').trim(),
        voiceStyle: String(section.voiceStyle || 'story-narrator'),
        ageGroup: String(section.ageGroup || 'Adult'),
        tone: String(section.tone || 'Warm'),
        speed: Number(section.speed || 1),
        pitch: Number(section.pitch || 1),
        pause: Number(section.pause || 0.25),
        characterName: section.characterName ? String(section.characterName) : '',
      }))
      .filter((section) => section.text);

    if (!cleanedSections.length) {
      return res.status(400).json({ error: 'Every section is empty after trimming.' });
    }

    const generatedClips = [];
    for (const [index, section] of cleanedSections.entries()) {
      const generated = await generateSpeechClipWithOpenAI(section, providerModel, outputFormat);
      const fileName = buildSafeFileName(title, `${index + 1}-${section.label}`, outputFormat);

      generatedClips.push({
        id: section.id,
        label: section.label,
        fileName,
        mimeType: generated.mimeType,
        audioBase64: generated.audioBase64,
        rawBuffer: generated.rawBuffer,
        textPreview: section.text.slice(0, 180),
        providerVoice: generated.voice,
        durationEstimateSec: Math.max(1, Math.round(section.text.split(/\s+/).length / 2.4)),
      });
    }

    const mergeResult = await tryMergeAudioBuffers(
      generatedClips,
      outputFormat,
      buildSafeFileName(title, 'combined', outputFormat).replace(`.${outputFormat}`, ''),
    );

    return res.json({
      ok: true,
      title,
      mode,
      provider,
      model: providerModel,
      outputFormat,
      clips: generatedClips.map(({ rawBuffer, ...rest }) => rest),
      combinedAudioBase64: mergeResult.mergedBase64,
      combinedMimeType: mergeResult.mergedMimeType,
      combinedFileName: mergeResult.mergedFileName,
      note: mergeResult.note,
    });
  } catch (error) {
    console.error('voice-story/generate error', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown audio generation error.',
    });
  }
});

export default router;
