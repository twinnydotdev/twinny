import * as assert from 'assert';
import { mock, instance, when, verify, deepEqual, anything, reset, spy } from 'ts-mockito';
import { ConversationHistory } from '../../../extension/conversation-history';
import { Chat } from '../../../extension/chat';
import { ExtensionContext, Webview, Memento } from 'vscode';
import { ChatCompletionMessageParam, UserMessage } from 'fluency.js';
import { ACTIVE_CONVERSATION_STORAGE_KEY, CONVERSATION_STORAGE_KEY } from '../../../common/constants';
import { Conversation } from '../../../common/types';

// Helper to create a more complete mock Memento
const createMockMemento = (): Memento => {
  const store: { [key: string]: any } = {};
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return store[key] || defaultValue;
    },
    update: <T>(key: string, value: T): Promise<void> => {
      store[key] = value;
      return Promise.resolve();
    }
  };
};

describe('ConversationHistory Title Generation', () => {
  let mockChatService: Chat;
  let mockExtensionContext: ExtensionContext;
  let mockWebview: Webview;
  let conversationHistory: ConversationHistory;
  let spiedConversationHistory: ConversationHistory;
  let mockGlobalState: Memento;
  let mockWorkspaceState: Memento;

  beforeEach(() => {
    mockChatService = mock(Chat);
    mockExtensionContext = mock<ExtensionContext>();
    mockWebview = mock<Webview>(); // Basic mock, might need more if postMessage is used by tested methods

    mockGlobalState = createMockMemento();
    mockWorkspaceState = createMockMemento(); // If needed

    when(mockExtensionContext.globalState).thenReturn(mockGlobalState);
    when(mockExtensionContext.workspaceState).thenReturn(mockWorkspaceState); // If needed

    // If webview.onDidReceiveMessage is important for these tests, mock it
    when(mockWebview.onDidReceiveMessage(anything())).thenReturn({ dispose: () => {} } as any);


    conversationHistory = new ConversationHistory(instance(mockExtensionContext), instance(mockWebview), instance(mockChatService));
    spiedConversationHistory = spy(conversationHistory);
  });

  afterEach(() => {
    reset(mockChatService);
    reset(spiedConversationHistory); // Reset spies
  });

  describe('_generateTitleWithLlm', () => {
    it('should return undefined for no messages', async () => {
      const title = await (conversationHistory as any)._generateTitleWithLlm([]);
      assert.strictEqual(title, undefined, "Title should be undefined for no messages");
      verify(mockChatService.generateSimpleCompletion(anything())).never();
    });

    it('should return undefined for messages with non-string content', async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: null as any }];
      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);
      assert.strictEqual(title, undefined, "Title should be undefined for non-string content");
      verify(mockChatService.generateSimpleCompletion(anything())).never();
    });

    it('should return undefined for messages with empty string content', async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: ' ' }];
      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);
      assert.strictEqual(title, undefined, "Title should be undefined for empty string content");
      verify(mockChatService.generateSimpleCompletion(anything())).never();
    });

    it('should call chatService.generateSimpleCompletion with correct prompt for one message and return trimmed title', async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'Hello world' }];
      const expectedPrompt = 'Generate a short, concise title (under 10 words) for a conversation that starts with the following messages:\n\nMessage 1: "Hello world"\n\nTitle:';
      when(mockChatService.generateSimpleCompletion(expectedPrompt)).thenResolve(' Test Title ');

      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);

      verify(mockChatService.generateSimpleCompletion(expectedPrompt)).once();
      assert.strictEqual(title, 'Test Title', "Title did not match or was not trimmed");
    });

    it('should call chatService.generateSimpleCompletion with correct prompt for two messages', async () => {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Second message' }
      ];
      const expectedPrompt = 'Generate a short, concise title (under 10 words) for a conversation that starts with the following messages:\n\nMessage 1: "First message"\nMessage 2: "Second message"\n\nTitle:';
      when(mockChatService.generateSimpleCompletion(expectedPrompt)).thenResolve('Two Message Title');

      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);

      verify(mockChatService.generateSimpleCompletion(expectedPrompt)).once();
      assert.strictEqual(title, 'Two Message Title');
    });
    
    it('should use only first message for prompt if second message content is not a string', async () => {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: null as any }
      ];
      const expectedPrompt = 'Generate a short, concise title (under 10 words) for a conversation that starts with the following messages:\n\nMessage 1: "First message"\n\nTitle:';
      when(mockChatService.generateSimpleCompletion(expectedPrompt)).thenResolve('First Only');

      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);
      verify(mockChatService.generateSimpleCompletion(expectedPrompt)).once();
      assert.strictEqual(title, 'First Only');
    });

    it('should return undefined if chatService.generateSimpleCompletion returns undefined', async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'Hello' }];
      const expectedPrompt = 'Generate a short, concise title (under 10 words) for a conversation that starts with the following messages:\n\nMessage 1: "Hello"\n\nTitle:';
      when(mockChatService.generateSimpleCompletion(expectedPrompt)).thenResolve(undefined);

      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);

      assert.strictEqual(title, undefined);
      verify(mockChatService.generateSimpleCompletion(expectedPrompt)).once();
    });

    it('should return undefined if chatService.generateSimpleCompletion throws an error', async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'Hello' }];
      const expectedPrompt = 'Generate a short, concise title (under 10 words) for a conversation that starts with the following messages:\n\nMessage 1: "Hello"\n\nTitle:';
      when(mockChatService.generateSimpleCompletion(expectedPrompt)).thenReject(new Error('LLM Error'));

      const title = await (conversationHistory as any)._generateTitleWithLlm(messages);

      assert.strictEqual(title, undefined);
      verify(mockChatService.generateSimpleCompletion(expectedPrompt)).once();
    });
  });

  describe('saveConversation', () => {
    let mockActiveConversation: Conversation;

    beforeEach(() => {
      mockActiveConversation = {
        id: 'active-convo-123',
        messages: [{ role: 'user', content: 'Existing message' } as UserMessage],
        title: 'Old Title',
        createdAt: new Date().toISOString(),
        tokens: 0
      };

      // Mock getActiveConversation behavior
      // In ConversationHistory, getActiveConversation calls this.context.globalState.get and then this.setActiveConversation
      // We need to mock the globalState.get part. setActiveConversation posts messages, which might not be relevant for these specific tests.
      when(mockExtensionContext.globalState.get(ACTIVE_CONVERSATION_STORAGE_KEY)).thenReturn(mockActiveConversation);
      
      // updateConversation also uses globalState and posts messages. We'll spy it to check its inputs.
      // For simplicity, we're not deeply testing the internals of updateConversation here, just that it's called correctly.
    });

    it('should use LLM title if _generateTitleWithLlm returns a title', async () => {
      const newMessages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'New message for title' }];
      const conversationToSave: Conversation = { ...mockActiveConversation, messages: newMessages as UserMessage[] };
      const llmTitle = 'LLM Generated Title';

      when(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).thenResolve(llmTitle);
      // We need to allow getConversationTitle to be callable on the spied object
      when(spiedConversationHistory['getConversationTitle'](anything())).thenCall((msgs) => {
        return `Fallback for: ${msgs[0].content.substring(0,10)}`;
      });


      await conversationHistory.saveConversation(conversationToSave);
      
      // Verify updateConversation was called with the LLM title
      // The actual call to updateConversation is on `this`, which is the real `conversationHistory` instance.
      // So we check the spied instance's method.
      verify(spiedConversationHistory['updateConversation'](deepEqual({
        ...mockActiveConversation,
        messages: newMessages as UserMessage[],
        title: llmTitle
      }))).once();
    });

    it('should use fallback title if _generateTitleWithLlm returns undefined', async () => {
      const newMessages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'New message for fallback' }];
      const conversationToSave: Conversation = { ...mockActiveConversation, messages: newMessages as UserMessage[] };
      const fallbackTitle = conversationHistory.getConversationTitle(newMessages); // Get expected fallback

      when(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).thenResolve(undefined);
      when(spiedConversationHistory['getConversationTitle'](deepEqual(newMessages as UserMessage[]))).thenReturn(fallbackTitle);


      await conversationHistory.saveConversation(conversationToSave);

      verify(spiedConversationHistory['updateConversation'](deepEqual({
        ...mockActiveConversation,
        messages: newMessages as UserMessage[],
        title: fallbackTitle
      }))).once();
    });

    it('should correctly slice messages for _generateTitleWithLlm (0 messages)', async () => {
      const newMessages: ChatCompletionMessageParam[] = []; // No messages
      const conversationToSave: Conversation = { ...mockActiveConversation, messages: newMessages as UserMessage[] };
      const fallbackTitle = conversationHistory.getConversationTitle(newMessages);

      // _generateTitleWithLlm will return undefined for empty messages
      when(spiedConversationHistory['_generateTitleWithLlm'](deepEqual([]))).thenResolve(undefined);
      when(spiedConversationHistory['getConversationTitle'](deepEqual(newMessages as UserMessage[]))).thenReturn(fallbackTitle);


      await conversationHistory.saveConversation(conversationToSave);
      
      verify(spiedConversationHistory['_generateTitleWithLlm'](deepEqual([]))).once();
      verify(spiedConversationHistory['updateConversation'](deepEqual({
        ...mockActiveConversation,
        messages: newMessages as UserMessage[],
        title: fallbackTitle
      }))).once();
    });

    it('should correctly slice messages for _generateTitleWithLlm (1 message)', async () => {
      const newMessages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'One message' }];
      const conversationToSave: Conversation = { ...mockActiveConversation, messages: newMessages as UserMessage[] };
      const llmTitle = 'LLM Title One';

      when(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).thenResolve(llmTitle);

      await conversationHistory.saveConversation(conversationToSave);

      verify(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).once();
      verify(spiedConversationHistory['updateConversation'](deepEqual({
        ...mockActiveConversation,
        messages: newMessages as UserMessage[],
        title: llmTitle
      }))).once();
    });

    it('should correctly slice messages for _generateTitleWithLlm (2 messages)', async () => {
      const newMessages: ChatCompletionMessageParam[] = [
        { role: 'user', content: 'Msg1' }, { role: 'assistant', content: 'Msg2' }
      ];
      const conversationToSave: Conversation = { ...mockActiveConversation, messages: newMessages as UserMessage[] };
      const llmTitle = 'LLM Title Two';

      when(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).thenResolve(llmTitle);

      await conversationHistory.saveConversation(conversationToSave);

      verify(spiedConversationHistory['_generateTitleWithLlm'](deepEqual(newMessages.slice(0,2)))).once();
      verify(spiedConversationHistory['updateConversation'](deepEqual({
        ...mockActiveConversation,
        messages: newMessages as UserMessage[],
        title: llmTitle
      }))).once();
    });
    
    it('should use fallback if activeConversation is not found (though current impl updates)', async () => {
      const newMessages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'New message' }];
      const conversationToSave: Conversation = { 
        id: 'new-convo-456', // Different ID, so it's not "active" in this setup
        messages: newMessages as UserMessage[],
        title: '', // No title initially
        createdAt: new Date().toISOString(),
        tokens: 0
      };
    
      // Mock getActiveConversation to return undefined
      when(mockExtensionContext.globalState.get(ACTIVE_CONVERSATION_STORAGE_KEY)).thenReturn(undefined);
      // If getActiveConversation returns undefined, saveConversation should ideally not proceed to update.
      // However, the current implementation of saveConversation *always* calls getActiveConversation(),
      // which itself calls setActiveConversation(undefined), and *then* if activeConversation was initially null,
      // it *doesn't* call updateConversation. This test checks that no update happens if no active convo.
    
      await conversationHistory.saveConversation(conversationToSave);
    
      // updateConversation should not be called if there's no active conversation initially
      verify(spiedConversationHistory['updateConversation'](anything())).never();
      // _generateTitleWithLlm should also not be called if there's no active conversation
      verify(spiedConversationHistory['_generateTitleWithLlm'](anything())).never();
    });
  });
});

// Note: To run these tests, you'd typically need a VS Code test runner setup,
// like using `@vscode/test-electron`. The `ts-mockito` library is great for mocking.
// Ensure your `package.json` and test scripts are configured for this.
// The `spy` function from ts-mockito is used to verify calls on methods of the
// actual `conversationHistory` instance, especially for `updateConversation` and `getActiveConversation`
// which are part of the same class.
// Making `_generateTitleWithLlm` public for testing or using `(conversationHistory as any)` is a common pattern.
// If `_generateTitleWithLlm` remains private, you can test it indirectly via `saveConversation` or
// use the `(instance as any)._generateTitleWithLlm` trick if your test environment allows.
// The current tests for `_generateTitleWithLlm` use `(conversationHistory as any)` for direct testing.
// For `saveConversation` tests, we spy on `conversationHistory` to verify calls to its own methods like
// `_generateTitleWithLlm` and `updateConversation`.

// Added afterEach to reset spies and mocks to ensure test isolation.
// Added a more robust Memento mock.
// Corrected spy usage and verification for saveConversation tests.
// Addressed the case where `getActiveConversation` could return undefined.
```
