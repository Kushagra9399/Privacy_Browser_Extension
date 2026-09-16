/**
 * Local agent reasoning bridge.
 *
 * The existing AgentLoopOrchestrator remains the execution/safety layer.
 * This bridge replaces only its local action planner with the on-device
 * reasoning model and keeps the existing deterministic rules as fallback.
 */

(() => {
    if (typeof AgentLoopOrchestrator === 'undefined') {
        Logger.warn('LOCAL_AGENT', 'AgentLoopOrchestrator is not available');
        return;
    }

    const originalGetLocalAction =
        AgentLoopOrchestrator.prototype.getLocalAction;

    AgentLoopOrchestrator.prototype.getLocalAction = async function () {
        const goal = String(
            this.sessionManager.currentGoal || ''
        ).trim();

        if (!goal) {
            return {
                type: 'finish',
                reason: 'No agent goal was provided'
            };
        }

        try {
            const observation = this.sessionManager.buildObservation();

            Logger.log(
                'LOCAL_AGENT',
                `Reasoning locally about goal: ${goal}`
            );

            const response = await chrome.runtime.sendMessage({
                type: 'offscreen_reasoning_request',
                goal,
                observation
            });

            if (response?.success && response.action) {
                Logger.log(
                    'LOCAL_AGENT',
                    `Local model selected action: ${response.action.type}`,
                    response.action
                );

                return response.action;
            }

            Logger.warn(
                'LOCAL_AGENT',
                `Local model unavailable: ${response?.error || 'unknown error'}; using deterministic local fallback`
            );
        } catch (error) {
            Logger.warn(
                'LOCAL_AGENT',
                'Local model request failed; using deterministic local fallback'
            );
            Logger.debug?.('LOCAL_AGENT', error?.message);
        }

        return originalGetLocalAction.call(this);
    };
})();
