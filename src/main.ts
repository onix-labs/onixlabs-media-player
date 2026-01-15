import {bootstrapApplication} from '@angular/platform-browser';
import {appConfig} from './app/app.config';
import {Root} from './app/components/root/root';

bootstrapApplication(Root, appConfig).catch((error: any): void => console.error(error));
