import { NonRealTimeVAD, type NonRealTimeVADOptions } from "@ricky0123/vad-node";

export class SileroVadRuntime {
	async createDetector(options?: Partial<NonRealTimeVADOptions>): Promise<NonRealTimeVAD> {
		return NonRealTimeVAD.new(options);
	}
}
