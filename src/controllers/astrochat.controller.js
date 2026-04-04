import { doAstroChat } from '../services/astrochat.service.js';

export const astroChatController = {
  async postMessage(req, res) {
    try {
      debugger;
      const { expertId, question, tone, user } = req.body || {};
      if (!question) {
        return res.status(400).json({ ok: false, error: 'question is required' });
      }

      const authUserId = req.user?.id ?? req.body?.authUserId;

      if (!authUserId) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      console.log(
        '[astroChatController] astroContext.meta:',
        req.body?.astroContext && req.body.astroContext.meta
      );
      console.log(
        '[astroChatController] birthProfile:',
        req.body?.birthProfile
      );

      const result = await doAstroChat({
        expertId,
        question,
        tone,
        userProfile: user,
        authUserId,
        location: req.body?.location ?? null,
        birthProfile: req.body?.birthProfile ?? null,
        astroContext: req.body?.astroContext ?? null
      });

      if (result?.ok === false && result?.error === 'insufficient_balance') {
        return res.status(402).json(result);
      }

      return res.json(result);
    } catch (e) {
      console.error('[astrochat] error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
};
