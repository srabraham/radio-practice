import { loginForm } from './common.js';
import { powerOn } from './radio.js';
import { openConsole } from './console.js';

loginForm({ onInstructor: openConsole, onParticipant: powerOn });
