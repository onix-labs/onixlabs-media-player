import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LayoutControls } from './layout-controls';

describe('LayoutControls', (): void => {
  let component: LayoutControls;
  let fixture: ComponentFixture<LayoutControls>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [LayoutControls]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LayoutControls);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });
});
