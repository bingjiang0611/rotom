export const authenticationCopy = {
	selectModel: (providerId: string): string => `Use /model to select a model for provider "${providerId}".`,
};

export const footerCopy = {
	tokensPerSecond: (value: number): string => `${value.toFixed(1)} t/s`,
};
